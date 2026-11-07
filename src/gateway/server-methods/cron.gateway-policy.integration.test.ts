import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
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
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { revokeCronCreatorAuthorityRunScope } from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { cronHandlers } from "./cron.js";
import { createCronJob } from "./cron.validation.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const gatewayCall = vi.hoisted(() => vi.fn());
vi.mock("../../agents/tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/tools/gateway.js")>()),
  callGatewayTool: gatewayCall,
}));

const managed = {
  tools: {
    gatewayPolicy: {
      allow: ["automations"],
      actions: { automations: ["list", "get", "add", "update", "run", "remove"] },
      automations: { scope: "caller", allowCommandJobs: false },
    },
  },
} satisfies OpenClawConfig;
const commandRestricted: OpenClawConfig = {
  tools: {
    gatewayPolicy: {
      ...managed.tools.gatewayPolicy,
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
const commandJob: CronJobCreate = {
  ...jobInput,
  payload: { kind: "command", argv: ["fixture-command"] },
};
const addOwnedJob = (cron: CronService) =>
  cron.add(
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
function expectDenied(response: Parameters<RespondFn>, message: string) {
  expect(response[0]).toBe(false);
  expect(response[2]?.message).toContain(message);
}

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

function createPolicyFixture(storePath: string) {
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
    directClient?: GatewayClient,
  ) => {
    const client = directClient ?? createSyntheticPluginRuntimeClient({ scopes });
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
    return expectDefined(respond.mock.calls[0], "cron response");
  };

  return {
    scheduler,
    cron,
    readJobs: () => loadCronStore(storePath),
    commandRunner,
    invoke,
    tool: (identity: AgentRuntimeIdentity) => {
      gatewayCall.mockImplementation(async (method: string, _options: unknown, params: unknown) => {
        const caller = getGatewayToolCallerIdentity();
        const response = await invoke(method, params as Record<string, unknown>, {
          ...identity,
          ...caller,
        });
        const [ok, value, error] = response;
        if (!ok) {
          throw new Error(error?.message ?? "cron request denied");
        }
        return value;
      });
      return createCronTool({
        config: getRuntimeConfigSnapshot() ?? {},
        runId: identity.operationalRunInstance.runId,
        agentSessionKey: identity.sessionKey,
      });
    },
  };
}

async function withCron(run: (fixture: ReturnType<typeof createPolicyFixture>) => Promise<void>) {
  await withOpenClawTestState({ label: "cron-gateway-policy" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const fixture = createPolicyFixture(state.statePath("cron", "jobs.json"));
    try {
      await fixture.cron.start();
      await run(fixture);
    } finally {
      fixture.cron.stop();
      await fixture.scheduler.stop();
    }
  });
}

describe("Gateway automation policy", () => {
  it.each(["control-ui-admin", "channel-owner"] as const)(
    "keeps %s model calls scoped and preserves ordinary updates",
    async (source) => {
      await withCron(async ({ cron, tool, invoke, readJobs }) => {
        const owned = await addOwnedJob(cron);
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
            expectDenied(denied, "Automation not found");
            const allowed = await invoke(method, { id: owned.id }, identity);
            expect(allowed[0]).toBe(true);
            if (method === "cron.run") {
              expect(allowed[1]).toMatchObject({ ok: true, enqueued: true });
            }
          }
        });
        const { jobs } = await readJobs();
        expect(jobs.find((job) => job.id === foreign.id)?.description).toBeUndefined();
        expect(jobs.find((job) => job.id === owned.id)).toBeUndefined();
      });
    },
  );

  it.each(["operator.cron", "operator.write"])(
    "allows %s to manage only the current conversation's jobs without a management policy",
    async (scope) => {
      await withCron(async ({ cron, invoke, readJobs }) => {
        const owned = await addOwnedJob(cron);
        const foreign = await cron.add({
          ...jobInput,
          owner: { sessionKey: "agent:main:other", agentId: "main", accountId: "default" },
        });
        await withModelTurn("channel-owner", async (identity) => {
          const list = await invoke("cron.list", { includeDisabled: true }, identity, undefined, [
            scope,
          ]);
          expect(list[0]).toBe(true);
          expect(list[1]).toMatchObject({ jobs: [expect.objectContaining({ id: owned.id })] });
          for (const method of ["cron.get", "cron.update", "cron.run", "cron.remove"]) {
            const params = method === "cron.update" ? { patch: { description: "allowed" } } : {};
            expectDenied(
              await invoke(method, { id: foreign.id, ...params }, identity, undefined, [scope]),
              method === "cron.get" ? "cron job not found" : "Automation not found",
            );
            const response = await invoke(
              method,
              { id: owned.id, ...params },
              identity,
              undefined,
              [scope],
            );
            expect(response[0], response[2]?.message).toBe(true);
          }
        });
        expect((await readJobs()).jobs.map((job) => job.id)).toEqual([foreign.id]);
      });
    },
  );

  it.each([
    "cron-only direct caller",
    "ordinary caller",
    "session-only runtime",
    "read-only runtime",
    "revoked before commit",
  ] as const)("keeps mutation authority restricted for %s", async (scenario) => {
    await withCron(async ({ cron, invoke, readJobs }) => {
      const job = await addOwnedJob(cron);
      const before = await readJobs();
      setRuntimeConfigSnapshot({});
      for (const method of ["cron.update", "cron.remove", "cron.run"]) {
        // Each method needs a fresh admitted run so revocation happens at its own commit.
        await withModelTurn("channel-owner", async (identity) => {
          const response = await invoke(
            method,
            {
              id: job.id,
              ...(method === "cron.update" ? { patch: { description: "denied" } } : {}),
            },
            scenario === "ordinary caller" || scenario === "cron-only direct caller"
              ? undefined
              : identity,
            scenario === "revoked before commit"
              ? () => releaseAgentRunDelegatedAuthority(identity.delegatedAuthority)
              : undefined,
            [
              scenario === "read-only runtime"
                ? "operator.read"
                : scenario === "session-only runtime"
                  ? "operator.sessions.write"
                  : scenario === "cron-only direct caller"
                    ? "operator.cron"
                    : "operator.write",
            ],
          );
          if (scenario === "revoked before commit") {
            expectDenied(response, "authority is no longer active");
          } else {
            expect(response[0]).toBe(false);
            expect(response[2]?.message).toBe("missing scope: operator.admin");
          }
        });
        expect(await readJobs()).toEqual(before);
      }
    });
  });

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
        const job = await cron.add(command ? commandJob : jobInput);
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
          expectDenied(response, "command automations");
        });
        expect(await readJobs()).toEqual(before);
      });
    },
  );

  it("blocks kindless model updates after resolving the stored command payload", async () => {
    await withCron(async ({ cron, tool, readJobs }) => {
      const job = await cron.add(commandJob);
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
      const job = await cron.add(commandJob);
      setRuntimeConfigSnapshot(commandRestricted);
      await withModelTurn("control-ui-admin", async (identity) => {
        const create = await invoke("cron.add", commandJob, identity, undefined, [
          "operator.admin",
        ]);
        expectDenied(create, "command automations");
        await expect(
          tool(identity).execute("run", { action: "run", jobId: job.id }),
        ).rejects.toThrow("command automations");
      });
      expect((await readJobs()).jobs).toHaveLength(1);
      expect(commandRunner).not.toHaveBeenCalled();
      const create = await invoke("cron.add", { ...commandJob, name: "human-created command" });
      expect(create[0]).toBe(true);
      expect((await readJobs()).jobs).toHaveLength(2);
      const update = await invoke("cron.update", {
        id: job.id,
        patch: { description: "human edit" },
      });
      expect(update[0]).toBe(true);
      const run = await invoke("cron.run", { id: job.id, mode: "force", waitTimeoutMs: 10_000 });
      expect(run[0]).toBe(true);
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

it("allows only the current human owner or admin to edit and transfer an automation", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: true },
    async (state) => {
      const cfg = rolePolicyConfig();
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const alice = roleClient("view", "automation-alice");
      const bob = roleClient("view", "automation-bob");
      const aliceId = expectDefined(alice.authenticatedUserProfile, "Alice").profileId;
      const bobId = expectDefined(bob.authenticatedUserProfile, "Bob").profileId;
      const fixture = createPolicyFixture(state.path("cron", "jobs.json"));
      const { cron, invoke } = fixture;
      try {
        const job = await cron.add(jobInput, {
          createdActor: { type: "human", source: "profile", id: aliceId },
        });
        expect(job.ownerProfileId).toBe(aliceId);
        const update = (client: GatewayClient, patch: Record<string, unknown>) =>
          invoke("cron.update", { id: job.id, patch }, undefined, undefined, undefined, client);
        expect((await update(alice, { description: "owned edit" }))[0]).toBe(true);
        expect(
          (await invoke("cron.update", { id: job.id, patch: { description: "admin edit" } }))[0],
        ).toBe(true);
        expectDenied(await update(bob, { description: "foreign edit" }), "Automation not found");
        expectDenied(await update(bob, { ownerProfileId: bobId }), "Automation not found");
        expectDenied(
          await update(alice, { ownerProfileId: "missing-profile" }),
          "existing human owner",
        );
        expect((await update(alice, { ownerProfileId: bobId }))[0]).toBe(true);
        expect(cron.getJob(job.id)).toMatchObject({
          ownerProfileId: bobId,
          enabled: false,
          createdActor: { id: aliceId },
        });
        expect(
          (await fixture.readJobs()).jobs.find((stored) => stored.id === job.id),
        ).toMatchObject({
          ownerProfileId: bobId,
          enabled: false,
          runtimeAuthorityRecoveryRequired: true,
          createdActor: { id: aliceId },
        });
        expectDenied(await update(alice, { description: "former owner" }), "Automation not found");
        expect((await update(bob, { description: "new owner" }))[0]).toBe(true);
        expectDenied(
          await invoke("cron.remove", { id: job.id }, undefined, undefined, undefined, alice),
          "Automation not found",
        );
        expect(
          (await invoke("cron.remove", { id: job.id }, undefined, undefined, undefined, bob))[0],
        ).toBe(true);
      } finally {
        cron.stop();
        await fixture.scheduler.stop();
      }
    },
  );
});

describe("Gateway automation execution agent", () => {
  // Both agents must be configured with a routable model: create-time inference capture resolves
  // the execution agent's own catalog and credential, which is the leg that used to run for the
  // configured default agent while the job was stored for another one.
  const twoAgents = {
    agents: {
      defaults: { skipBootstrap: true, model: "openai/gpt-4.1" },
      entries: { main: {}, worker: {} },
    },
    plugins: { enabled: false },
  } satisfies OpenClawConfig;
  const workerSessionJob = (overrides: Partial<CronJobCreate> = {}): CronJobCreate => ({
    name: "probe",
    enabled: false,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "session:agent:worker:dashboard:2b6f1c9a",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "ping", toolsAllow: [] },
    delivery: { mode: "none" },
    ...overrides,
  });
  const createdJobId = (response: Parameters<RespondFn>) => {
    // A declaration-keyed create reports `{ created, job }`; a plain create reports the job itself.
    const payload = response[1] as { id?: string; job?: { id: string } } | undefined;
    return expectDefined(payload?.job?.id ?? payload?.id, "created job id");
  };

  async function withTwoAgentCron(
    run: (fixture: ReturnType<typeof createPolicyFixture>) => Promise<void>,
  ) {
    await withOpenClawTestState({ label: "cron-execution-agent" }, async (state) => {
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        profiles: [
          {
            profileId: "openai:cron-execution-agent",
            credential: {
              type: "api_key",
              provider: "openai",
              key: "synthetic-execution-agent-key",
            },
          },
        ],
      });
      setRuntimeConfigSnapshot(twoAgents);
      const fixture = createPolicyFixture(state.statePath("cron", "jobs.json"));
      try {
        await fixture.cron.start();
        await run(fixture);
      } finally {
        fixture.cron.stop();
        await fixture.scheduler.stop();
      }
    });
  }

  it("stores the session's agent and converges a repeated declaration onto that job", async () => {
    await withTwoAgentCron(async ({ invoke, readJobs }) => {
      const declaration = { ...workerSessionJob(), declarationKey: "daily-probe" };
      const first = await invoke("cron.add", declaration);
      expect(first[2]?.message ?? first[0]).toBe(true);
      const jobId = createdJobId(first);
      const repeat = await invoke("cron.add", declaration);
      expect(repeat[2]?.message ?? repeat[0]).toBe(true);
      expect(createdJobId(repeat)).toBe(jobId);
      const { jobs } = await readJobs();
      expect(jobs.map((job) => job.id)).toEqual([jobId]);
      expect(jobs[0]).toMatchObject({ agentId: "worker", declarationKey: "daily-probe" });
    });
  });

  it("reports the session's agent to operator listings and keeps it out of the default agent", async () => {
    await withTwoAgentCron(async ({ invoke, readJobs }) => {
      const created = await invoke("cron.add", workerSessionJob());
      expect(created[2]?.message ?? created[0]).toBe(true);
      const jobId = createdJobId(created);
      expect((await readJobs()).jobs.map((job) => job.agentId)).toEqual(["worker"]);
      const listed = await invoke("cron.list", { includeDisabled: true, agentId: "worker" });
      expect(listed[0]).toBe(true);
      expect((listed[1] as { jobs: { id: string }[] }).jobs.map((job) => job.id)).toEqual([jobId]);
      const defaultAgent = await invoke("cron.list", { includeDisabled: true, agentId: "main" });
      expect((defaultAgent[1] as { jobs: unknown[] }).jobs).toEqual([]);
    });
  });

  it("still refuses an agent caller a job that another agent would execute", async () => {
    await withTwoAgentCron(async ({ invoke, readJobs }) => {
      await withModelTurn("control-ui-admin", async (identity) => {
        expectDenied(
          await invoke("cron.add", workerSessionJob(), identity, undefined, ["operator.admin"]),
          "job agentId outside caller scope",
        );
        const own = await invoke(
          "cron.add",
          workerSessionJob({
            name: "own probe",
            sessionTarget: "session:agent:main:dashboard:2b6f1c9a",
          }),
          identity,
          undefined,
          ["operator.admin"],
        );
        expect(own[2]?.message ?? own[0]).toBe(true);
      });
      expect((await readJobs()).jobs.map((job) => job.agentId)).toEqual(["main"]);
    });
  });

  it("loads and serves a job stored before execution agents were bound at admission", async () => {
    await withOpenClawTestState({ label: "cron-legacy-owner" }, async (state) => {
      setRuntimeConfigSnapshot(twoAgents);
      const storePath = state.statePath("cron", "jobs.json");
      // A row written by an older build: no owner, but a session reference naming another agent.
      const legacy = createCronJob({
        id: "legacy-worker-job",
        name: "legacy probe",
        enabled: false,
        sessionTarget: "session:agent:worker:dashboard:2b6f1c9a",
      });
      await saveCronStore(storePath, { version: 1, jobs: [legacy] });
      const fixture = createPolicyFixture(storePath);
      try {
        await fixture.cron.start();
        const get = await fixture.invoke("cron.get", { id: legacy.id });
        expect(get[0]).toBe(true);
        expect((get[1] as { name: string }).name).toBe("legacy probe");
        const list = await fixture.invoke("cron.list", { includeDisabled: true });
        expect(list[0]).toBe(true);
        expect((list[1] as { jobs: { id: string }[] }).jobs.map((job) => job.id)).toEqual([
          legacy.id,
        ]);
        // Reading a stored job never reinterprets it: the blank owner survives unchanged.
        expect((await fixture.readJobs()).jobs[0]?.agentId ?? null).toBeNull();
      } finally {
        fixture.cron.stop();
        await fixture.scheduler.stop();
      }
    });
  });
});
