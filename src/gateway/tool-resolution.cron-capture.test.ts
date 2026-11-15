import assert from "node:assert/strict";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { resolveExecTarget } from "../agents/bash-tools.exec-target.js";
import * as pluginTools from "../agents/openclaw-plugin-tools.js";
import { resolveScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadCronStore } from "../cron/store.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-approval-authority.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { createReadService } from "./server-methods/cron-read.test-support.js";

const SESSION = "agent:main:main";
const RUN = "cli-cron-capture";
const makeTool = (name: string, execute: AnyAgentTool["execute"]): AnyAgentTool => ({
  name,
  label: name,
  description: "Fixture tool",
  parameters: { type: "object" },
  execute,
});
function findTool<T extends { name: string }>(tools: readonly T[], name: string): T {
  return expectDefined(
    tools.find((tool) => tool.name === name),
    name,
  );
}
const emptyResult = async () => ({ content: [], details: {} });

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps cached standalone plugin tools fenced by their original live grant", async () => {
  const root = tempDirs.make("openclaw-plugin-grant-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const cfg: OpenClawConfig = { tools: { allow: ["probe"] }, plugins: { enabled: false } };
  setRuntimeConfigSnapshot(cfg);
  let current = true;
  const effect = vi.fn();
  vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptionsAsync").mockImplementation(
    async ({ options }) => {
      const assertCurrent = expectDefined(options?.assertInvocationCurrent, "grant guard");
      return [
        makeTool("probe", async () => {
          assertCurrent();
          effect();
          return emptyResult();
        }),
      ];
    },
  );
  const cache = new McpLoopbackToolCache();
  const input = {
    cfg,
    context: { sessionKey: SESSION, senderIsOwner: true, toolsAllow: ["probe"] },
    grantToken: "fixture-grant",
    isGrantCurrent: () => current,
  };
  const first = await cache.resolve(input);
  const second = await cache.resolve(input);
  const tool = findTool(second.tools, "probe");
  expect(second).toBe(first);
  await tool.execute("allowed", {});
  expect(effect).toHaveBeenCalledOnce();
  current = false;
  await expect(tool.execute("revoked", {})).rejects.toThrow("grant is no longer active");
  expect(effect).toHaveBeenCalledOnce();
});

it.each(["inherited", "finite", "schema-filtered", "denied", "excluded"] as const)(
  "persists the %s creator authority",
  async (scenario) => {
    const unreadableSchema = scenario === "schema-filtered";
    const nativeExec = !unreadableSchema;
    const toolsAllow = scenario === "finite" ? ["exec"] : undefined;
    const nativeRestriction =
      scenario === "denied" ? "deny" : scenario === "excluded" ? "allow" : undefined;
    const root = tempDirs.make("openclaw-cli-cron-capture-");
    const storePath = path.join(root, "cron", "jobs.json");
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {} },
        defaults: { model: "openai/gpt-4.1", sandbox: { mode: "non-main" } },
      },
      tools: {
        allow: [
          "automations",
          ...(nativeRestriction === "allow" ? [] : ["exec"]),
          ...(!nativeExec ? ["sessions_list"] : []),
          ...(unreadableSchema ? ["unreadable_plugin"] : []),
        ],
        ...(nativeRestriction === "deny" ? { deny: ["exec"] } : {}),
        exec: { host: "auto" },
      },
      plugins: { enabled: false },
    };
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    await persistAuthProfileBatch({
      stateDir: root,
      profiles: [
        {
          profileId: "openai:fixture",
          credential: { type: "api_key", provider: "openai", key: "synthetic-key" },
        },
      ],
    });
    setRuntimeConfigSnapshot(cfg);
    if (unreadableSchema) {
      // Plugin admission accepts this schema object; MCP cannot serialize it.
      const tool = makeTool("unreadable_plugin", vi.fn(emptyResult));
      Object.defineProperty(tool.parameters, "properties", {
        enumerable: true,
        get: () => {
          throw new Error("plugin schema is unavailable");
        },
      });
      vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptionsAsync").mockResolvedValue([tool]);
    }
    const cron = createReadService({
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const context = createDirectChatContext({
      cron,
      cronStorePath: storePath,
      getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const { operationalRunInstance } = createTestAdmittedRunContext(RUN);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    registerAgentRunContext(RUN, { agentId: "main", sessionKey: SESSION });
    try {
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: SESSION,
          turnSourceLocal: true,
          turnSourceAccountId: "default",
          operationalRunInstance,
          approvalAuthority: authority,
          receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
          gatewayContextResolver: () => context,
        },
        async () => {
          const scoped = await new McpLoopbackToolCache().resolve({
            cfg,
            context: {
              sessionKey: SESSION,
              runId: RUN,
              accountId: "default",
              senderIsOwner: true,
              ...(!nativeExec
                ? {
                    toolsAllow: ["automations", ...(unreadableSchema ? ["unreadable_plugin"] : [])],
                  }
                : {}),
              nativeCronCreatorToolAllowlist: nativeExec ? ["exec"] : [],
            },
          });
          expect(scoped.toolSchema.map((tool) => tool.name)).toEqual(["automations"]);
          await findTool(scoped.tools, "automations").execute("create", {
            action: "add",
            job: {
              name: "Read the Gateway input",
              enabled: false,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              payload: {
                kind: "agentTurn",
                message: "Read the input on the Gateway host.",
                ...(toolsAllow ? { toolsAllow } : {}),
              },
              delivery: { mode: "none" },
            },
          });
        },
      );
      const stored = expectDefined((await loadCronStore(storePath)).jobs[0], "persisted job");
      assert(stored.payload.kind === "agentTurn");
      const policy = resolveScheduledToolPolicyContext({
        toolsAllow: stored.payload.toolsAllow,
        scheduledToolPolicy: stored.scheduledToolPolicy,
        callerOrigin: stored.toolsAllowProvenance?.callerOrigin,
        execTarget: stored.toolsAllowExecTarget,
      });
      const capturesNativeExec = nativeExec && !nativeRestriction;
      expect(stored.payload.toolsAllow).toEqual(toolsAllow ?? ["*"]);
      expect(stored.toolsAllowExecTarget).toEqual(
        capturesNativeExec ? { version: 1, host: "gateway" } : undefined,
      );
      if (capturesNativeExec) {
        // Ordinary sandbox availability must not replace the captured target.
        expect(
          resolveExecTarget({
            configuredTarget: policy?.execTarget?.host ?? cfg.tools?.exec?.host,
            elevatedRequested: false,
            sandboxAvailable: true,
          }).effectiveHost,
        ).toBe("gateway");
      }
      expect(stored.scheduledToolPolicy).toEqual({
        version: 1,
        mode: "account",
        ownerSessionKey: SESSION,
        ownerAccountId: "default",
      });
    } finally {
      cron.stop();
      releaseAgentRunDelegatedAuthority(authority);
      clearAgentRunContext(RUN);
    }
  },
);
