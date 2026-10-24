import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAccountCronScheduledToolPolicy } from "../../cron/scheduled-tool-policy.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore } from "../../cron/store.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { revokeCronCreatorAuthorityRunScope } from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { cronHandlers } from "./cron.js";
import type { RespondFn } from "./types.js";

const gatewayCall = vi.hoisted(() => vi.fn());
vi.mock("../../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway.js")>()),
  callGatewayTool: gatewayCall,
}));

const managed: OpenClawConfig = {
  tools: {
    gatewayPolicy: {
      allow: ["automations"],
      actions: { automations: ["list", "get", "add", "update", "run", "remove"] },
      automations: { scope: "caller", allowCommandJobs: false },
    },
  },
};
const commandRestricted: OpenClawConfig = {
  tools: {
    gatewayPolicy: {
      allow: ["automations"],
      actions: managed.tools?.gatewayPolicy?.actions,
      automations: { allowCommandJobs: false },
    },
  },
};
const jobInput: CronJobCreate = {
  name: "scheduled task",
  enabled: false,
  agentId: "main",
  schedule: { kind: "every", everyMs: 3_600_000 },
  sessionTarget: "isolated",
  wakeMode: "next-heartbeat",
  payload: { kind: "agentTurn", message: "Read the workspace", toolsAllow: [] },
  delivery: { mode: "none" },
};

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

async function withModelTurn(
  source: "control-ui-admin" | "channel-owner",
  run: (identity: AgentRuntimeIdentity) => Promise<void>,
) {
  const runId = "automation-policy-model";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capability = expectDefined(
    createCronCreatorAuthorityCapability(
      runId,
      { kind: "local" },
      source === "channel-owner" ? { source, isCurrent: () => true } : { source },
    ),
    "model authority",
  );
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:main",
    operationalRunInstance,
    delegatedAuthority: { kind: "local", ...authority },
  };
  try {
    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, () =>
        run(identity),
      ),
    );
  } finally {
    revokeCronCreatorAuthorityRunScope(capability);
    releaseAgentRunDelegatedAuthority(authority);
  }
}

async function withCron(
  run: (fixture: {
    cron: CronService;
    readJobs: () => Promise<Awaited<ReturnType<typeof loadCronStore>>>;
    commandRunner: ReturnType<typeof vi.fn>;
    invoke: (
      method: string,
      params: Record<string, unknown>,
      identity?: AgentRuntimeIdentity,
      commitGuard?: () => void,
      scopes?: string[],
    ) => Promise<ReturnType<typeof vi.fn<RespondFn>>>;
    tool: (identity: AgentRuntimeIdentity) => ReturnType<typeof createCronTool>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-gateway-policy" }, async (fixture) => {
    setRuntimeConfigSnapshot({});
    const storePath = fixture.statePath("cron", "jobs.json");
    const commandRunner = vi.fn(async () => ({ status: "ok" as const }));
    const scheduler = createTestGatewayScheduler();
    const cron = new CronService({
      scheduler,
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      runCommandJob: commandRunner,
    });
    const context = createDirectChatContext({
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => getRuntimeConfigSnapshot() ?? {},
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const invoke = async (
      method: string,
      params: Record<string, unknown>,
      identity?: AgentRuntimeIdentity,
      commitGuard?: () => void,
      scopes = identity ? ["operator.write"] : ["operator.admin"],
    ) => {
      const client = createSyntheticPluginRuntimeClient({ scopes });
      if (identity) {
        client.internal = { ...client.internal, agentRuntimeIdentity: identity };
      }
      const respond = vi.fn<RespondFn>();
      const handler = expectDefined(cronHandlers[method], method);
      await handleGatewayRequest({
        req: { type: "req", id: "policy", method, params },
        context,
        client,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: {
          [method]: commitGuard
            ? (options) =>
                handler({
                  ...options,
                  // Inject commit-time changes after the router's admission checks.
                  sessionMutationCommitGuard: () => {
                    options.sessionMutationCommitGuard?.();
                    commitGuard();
                  },
                })
            : handler,
        },
      });
      return respond;
    };
    try {
      await cron.start();
      await run({
        cron,
        readJobs: () => loadCronStore(storePath),
        commandRunner,
        invoke,
        tool: (identity) => {
          gatewayCall.mockImplementation(
            async (method: string, _options: unknown, params: unknown) => {
              const caller = getGatewayToolCallerIdentity();
              const response = await invoke(method, params as Record<string, unknown>, {
                ...identity,
                ...caller,
              });
              const [ok, value, error] = response.mock.calls[0]!;
              if (!ok) {
                throw new Error(error?.message ?? "cron request denied");
              }
              return value;
            },
          );
          return createCronTool({
            config: getRuntimeConfigSnapshot() ?? {},
            runId: identity.operationalRunInstance.runId,
            agentSessionKey: identity.sessionKey,
          });
        },
      });
    } finally {
      cron.stop();
      await scheduler.stop();
    }
  });
}

describe("Gateway automation policy", () => {
  it.each(["control-ui-admin", "channel-owner"] as const)(
    "keeps %s model calls scoped and preserves ordinary updates",
    async (source) => {
      await withCron(async ({ cron, tool, invoke, readJobs }) => {
        const owned = await cron.add(
          {
            ...jobInput,
            owner: { sessionKey: "agent:main:main", agentId: "main", accountId: "default" },
          },
          {
            scheduledToolPolicy: createAccountCronScheduledToolPolicy({
              ownerSessionKey: "agent:main:main",
              ownerAccountId: "default",
            }),
          },
        );
        const foreign = await cron.add({
          ...jobInput,
          agentId: "other",
          name: "another Agent's task",
        });
        setRuntimeConfigSnapshot(managed);
        await withModelTurn(source, async (identity) => {
          const automation = tool(identity);
          await expect(
            automation.execute("foreign", {
              action: "update",
              jobId: foreign.id,
              job: { description: "must not change" },
            }),
          ).rejects.toThrow();
          await automation.execute("owned", {
            action: "update",
            jobId: owned.id,
            job: { description: "allowed update" },
          });
          expect((await readJobs()).jobs.find((job) => job.id === owned.id)?.description).toBe(
            "allowed update",
          );
          for (const method of ["cron.run", "cron.remove"]) {
            const denied = await invoke(method, { id: foreign.id }, identity);
            expect(denied.mock.calls[0]?.[0]).toBe(false);
            expect(denied.mock.calls[0]?.[2]?.message).toContain("Automation not found");
            const allowed = await invoke(method, { id: owned.id }, identity);
            expect(allowed.mock.calls[0]?.[0]).toBe(true);
            if (method === "cron.run") {
              expect(allowed.mock.calls[0]?.[1]).toMatchObject({ ok: true, enqueued: true });
            }
          }
        });
        const { jobs } = await readJobs();
        expect(jobs.find((job) => job.id === foreign.id)?.description).toBeUndefined();
        expect(jobs.find((job) => job.id === owned.id)).toBeUndefined();
      });
    },
  );

  it.each(["policy absent", "ordinary caller", "read-only runtime"] as const)(
    "keeps mutation admission restricted for %s",
    async (scenario) => {
      await withCron(async ({ cron, invoke, readJobs }) => {
        const job = await cron.add(jobInput);
        const before = await readJobs();
        setRuntimeConfigSnapshot(scenario === "policy absent" ? {} : managed);
        await withModelTurn("channel-owner", async (identity) => {
          for (const method of ["cron.update", "cron.remove", "cron.run"]) {
            const response = await invoke(
              method,
              {
                id: job.id,
                ...(method === "cron.update" ? { patch: { description: "denied" } } : {}),
              },
              scenario === "ordinary caller" ? undefined : identity,
              undefined,
              [scenario === "read-only runtime" ? "operator.read" : "operator.write"],
            );
            expect(response.mock.calls[0]?.[0]).toBe(false);
            expect(response.mock.calls[0]?.[2]?.message).toBe("missing scope: operator.admin");
          }
        });
        expect(await readJobs()).toEqual(before);
      });
    },
  );

  it.each(["cron.update", "cron.remove", "cron.run"])(
    "rejects %s when the admitted caller is revoked before commit",
    async (method) => {
      await withCron(async ({ cron, invoke, readJobs }) => {
        const job = await cron.add(
          {
            ...jobInput,
            owner: { sessionKey: "agent:main:main", agentId: "main", accountId: "default" },
          },
          {
            scheduledToolPolicy: createAccountCronScheduledToolPolicy({
              ownerSessionKey: "agent:main:main",
              ownerAccountId: "default",
            }),
          },
        );
        const before = await readJobs();
        setRuntimeConfigSnapshot(managed);
        await withModelTurn("channel-owner", async (identity) => {
          const response = await invoke(
            method,
            {
              id: job.id,
              ...(method === "cron.update" ? { patch: { description: "denied" } } : {}),
            },
            identity,
            () => releaseAgentRunDelegatedAuthority(identity.delegatedAuthority),
          );
          expect(response.mock.calls[0]?.[0]).toBe(false);
          expect(response.mock.calls[0]?.[2]?.message).toContain("authority is no longer active");
        });
        expect(await readJobs()).toEqual(before);
      });
    },
  );

  it.each([
    ["conversion", false, { payload: { kind: "command", argv: ["fixture-command"] } }],
    ["on-exit conversion", false, { schedule: { kind: "on-exit", command: "fixture-command" } }],
    ["metadata", true, { description: "changed" }],
    ["enable", true, { enabled: true }],
    [
      "conversion away from command",
      true,
      { payload: { kind: "agentTurn", message: "changed", toolsAllow: [] } },
    ],
  ] satisfies Array<[string, boolean, CronJobPatch]>)(
    "blocks command %s without changing persisted jobs",
    async (_name, command, patch) => {
      await withCron(async ({ cron, invoke, readJobs }) => {
        const job = await cron.add({
          ...jobInput,
          ...(command ? { payload: { kind: "command" as const, argv: ["fixture-command"] } } : {}),
        });
        const before = await readJobs();
        // Keep admin grants to prove command policy independently of caller-scope filtering.
        setRuntimeConfigSnapshot(commandRestricted);
        await withModelTurn("control-ui-admin", async (identity) => {
          const grant = expectDefined(
            bindCronManagementGrant(identity.operationalRunInstance.runId),
            "management grant",
          ).mint("cron.update");
          const response = await invoke(
            "cron.update",
            { id: job.id, patch },
            { ...identity, cronManagementGrant: grant },
          );
          expect(response.mock.calls[0]?.[0]).toBe(false);
          expect(response.mock.calls[0]?.[2]?.message).toContain("command automations");
        });
        expect(await readJobs()).toEqual(before);
      });
    },
  );

  it("blocks kindless model updates after resolving the stored command payload", async () => {
    await withCron(async ({ cron, tool, readJobs }) => {
      const job = await cron.add({
        ...jobInput,
        payload: { kind: "command", argv: ["fixture-command"] },
      });
      const before = await readJobs();
      setRuntimeConfigSnapshot(commandRestricted);
      await withModelTurn("control-ui-admin", async (identity) => {
        // The tool resolves the stored kind before sending a typed RPC payload.
        await expect(
          tool(identity).execute("kindless", {
            action: "update",
            jobId: job.id,
            job: { payload: { timeoutSeconds: 3 } },
          }),
        ).rejects.toThrow("automation command payloads cannot be created or edited");
      });
      expect(await readJobs()).toEqual(before);
    });
  });

  it("blocks model command creation and runs while direct human administration succeeds", async () => {
    await withCron(async ({ cron, tool, invoke, readJobs, commandRunner }) => {
      const command = {
        ...jobInput,
        payload: { kind: "command" as const, argv: ["fixture-command"] },
      };
      const job = await cron.add(command);
      setRuntimeConfigSnapshot(commandRestricted);
      await withModelTurn("control-ui-admin", async (identity) => {
        const create = await invoke("cron.add", command, identity, undefined, ["operator.admin"]);
        expect(create.mock.calls[0]?.[0]).toBe(false);
        expect(create.mock.calls[0]?.[2]?.message).toContain("command automations");
        await expect(
          tool(identity).execute("run", { action: "run", jobId: job.id }),
        ).rejects.toThrow("command automations");
      });
      expect((await readJobs()).jobs).toHaveLength(1);
      expect(commandRunner).not.toHaveBeenCalled();
      const create = await invoke("cron.add", { ...command, name: "human-created command" });
      expect(create.mock.calls[0]?.[0]).toBe(true);
      expect((await readJobs()).jobs).toHaveLength(2);
      const update = await invoke("cron.update", {
        id: job.id,
        patch: { description: "human edit" },
      });
      expect(update.mock.calls[0]?.[0]).toBe(true);
      const run = await invoke("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 10_000 });
      expect(run.mock.calls[0]?.[0]).toBe(true);
      expect(commandRunner).toHaveBeenCalledOnce();
    });
  });

  it.each([
    ["explicit restricted deployment", managed, {}, false, false],
    ["explicit unrestricted deployment", {}, managed, true, true],
    ["startup fallback", undefined, managed, false, false],
    ["startup command restriction", undefined, commandRestricted, false, true],
  ] as const)(
    "constructs tools using the %s",
    async (_name, config, startup, commandAllowed, managementAllowed) => {
      setRuntimeConfigSnapshot(startup);
      await withModelTurn("control-ui-admin", async (identity) => {
        const automation = createCronTool({ config, runId: identity.operationalRunInstance.runId });
        expect(
          Value.Check(automation.parameters, {
            action: "update",
            jobId: "command-job",
            job: { payload: { kind: "command", argv: ["fixture-command"] } },
          }),
        ).toBe(commandAllowed);
        expect(
          bindCronManagementGrant(identity.operationalRunInstance.runId, config) !== undefined,
        ).toBe(managementAllowed);
      });
    },
  );
});
