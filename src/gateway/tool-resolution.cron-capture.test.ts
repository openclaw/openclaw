import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import * as pluginTools from "../agents/openclaw-plugin-tools.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { loadCronStore } from "../cron/store.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-approval-authority.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";

const SESSION = "agent:main:main";
const RUN = "cli-cron-capture";

describe("MCP automation creator capture", () => {
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
    vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions").mockImplementation(
      ({ options }) => {
        const assertCurrent = expectDefined(
          options?.assertInvocationCurrent,
          "standalone grant guard",
        );
        return [
          {
            name: "probe",
            label: "Probe",
            description: "Grant probe",
            parameters: { type: "object" },
            async execute() {
              assertCurrent();
              effect();
              return { content: [], details: {} };
            },
          },
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
    const tool = expectDefined(
      second.tools.find((entry) => entry.name === "probe"),
      "cached plugin tool",
    );
    expect(second).toBe(first);
    await tool.execute("allowed", {});
    expect(effect).toHaveBeenCalledOnce();
    current = false;
    await expect(tool.execute("revoked", {})).rejects.toThrow("grant is no longer active");
    expect(effect).toHaveBeenCalledOnce();
  });

  const cases: Array<{
    label: string;
    nativeExec: boolean;
    unreadableSchema?: boolean;
  }> = [
    { label: "native", nativeExec: true, unreadableSchema: false },
    { label: "restricted MCP", nativeExec: false, unreadableSchema: false },
    {
      label: "schema-filtered MCP",
      nativeExec: false,
      unreadableSchema: true,
    },
  ];
  it.each(cases)(
    "preserves the $label creator account through automation creation",
    async ({ nativeExec, unreadableSchema }) => {
      const root = tempDirs.make("openclaw-cli-cron-capture-");
      const storePath = path.join(root, "cron", "jobs.json");
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} }, defaults: { sandbox: { mode: "non-main" } } },
        tools: {
          allow: [
            "automations",
            "exec",
            ...(!nativeExec ? ["sessions_list"] : []),
            ...(unreadableSchema ? ["unreadable_plugin"] : []),
          ],
          exec: { host: "auto" },
        },
        plugins: { enabled: false },
      };
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      setRuntimeConfigSnapshot(cfg);
      if (unreadableSchema) {
        // Plugin admission accepts this schema object; MCP cannot serialize it.
        const tool: AnyAgentTool = {
          name: "unreadable_plugin",
          label: "Plugin tool",
          description: "Tool with an unreadable schema",
          parameters: { type: "object" },
          execute: vi.fn(async () => ({ content: [], details: {} })),
        };
        Object.defineProperty(tool.parameters, "properties", {
          enumerable: true,
          get: () => {
            throw new Error("plugin schema is unavailable");
          },
        });
        vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions").mockReturnValue([tool]);
      }
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const context = createDirectChatContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => cfg,
        getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
        trackExecution: trackAsyncWork,
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
                      toolsAllow: [
                        "automations",
                        ...(unreadableSchema ? ["unreadable_plugin"] : []),
                      ],
                    }
                  : {}),
                nativeCronCreatorToolAllowlist: nativeExec ? ["exec"] : [],
              },
            });
            expect(scoped.toolSchema.map((tool) => tool.name)).toEqual(["automations"]);
            await expectDefined(
              scoped.tools.find((tool) => tool.name === "automations"),
              "the final MCP automation tool",
            ).execute("create", {
              action: "add",
              job: {
                name: "Read the Gateway input",
                enabled: false,
                schedule: { kind: "every", everyMs: 60_000 },
                sessionTarget: "isolated",
                payload: {
                  kind: "agentTurn",
                  message: "Read the input on the Gateway host.",
                },
                delivery: { mode: "none" },
              },
            });
          },
        );
        const stored = expectDefined((await loadCronStore(storePath)).jobs[0], "persisted job");
        if (stored.payload.kind !== "agentTurn") {
          throw new Error("expected the created agent-turn payload");
        }
        expect(stored.owner).toEqual({
          agentId: "main",
          sessionKey: SESSION,
          accountId: "default",
        });
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
});
