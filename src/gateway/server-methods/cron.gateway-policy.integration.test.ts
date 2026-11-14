import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
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
  createChannelReminderAuthorityFactory,
  resolvePersonalReminderOrigin,
} from "../../auto-reply/reply/personal-reminder-origin.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
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
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { cronHandlers } from "./cron.js";
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
  vi.unstubAllEnvs();
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
    context,
    scheduler,
    cron,
    readJobs: () => loadCronStore(storePath),
    commandRunner,
    invoke,
    tool: (identity: AgentRuntimeIdentity, creatorToolAllowlist?: string[]) => {
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
        creatorToolAllowlist,
      });
    },
  };
}

async function withCron(run: (fixture: ReturnType<typeof createPolicyFixture>) => Promise<void>) {
  await withOpenClawTestState({ label: "cron-gateway-policy" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const fixture = createPolicyFixture(state.statePath("cron", "jobs.json"));
    const projection = await createSessionRowProjection({
      cfg: {},
      getConfig: fixture.context.getRuntimeConfig,
      context: fixture.context,
    });
    bindSessionRowProjection(fixture.context, () => projection);
    try {
      await fixture.cron.start();
      await run(fixture);
    } finally {
      projection.dispose();
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
        for (const sessionKey of ["agent:main:main", "agent:main:other"]) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            { sessionId: sessionKey, updatedAt: 1, visibility: "shared" },
          );
        }
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

// Exercise the real cron handlers with two humans sharing the same group session.
it("limits personal reminder reads and removal to the originating human in one topic", async () => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-reminder-fixture-key");
  await withCron(async ({ cron, invoke }) => {
    const sessionKey = "agent:main:main";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: sessionKey, updatedAt: 1, visibility: "shared" },
    );
    const add = (profileId: string, threadId = "topic-1") =>
      cron.add(
        {
          ...jobInput,
          schedule: { kind: "at", at: "2030-01-01T00:00:00.000Z" },
          owner: { sessionKey, agentId: "main", accountId: "default" },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "group-1",
            accountId: "default",
            threadId,
          },
        },
        {
          createdActor: { type: "human", source: "profile", id: profileId },
          scheduledToolPolicy: createAccountCronScheduledToolPolicy({
            ownerSessionKey: sessionKey,
            ownerAccountId: "default",
          }),
        },
      );
    const alice = await add("alice");
    const bob = await add("bob");
    const aliceOtherTopic = await add("alice", "topic-2");
    await withModelTurn("channel-owner", async (identity) => {
      const scope = expectDefined(
        createCronCreatorAuthorityCapability(
          identity.operationalRunInstance.runId,
          { kind: "local" },
          undefined,
          () => true,
          undefined,
          undefined,
          true,
          {
            profileId: "alice",
            agentId: "main",
            sessionKey,
            sessionId: sessionKey,
            accountId: "default",
            to: "group-1",
            threadId: "topic-1",
          },
        ),
        "alice scope",
      );
      const bobScope = expectDefined(
        createCronCreatorAuthorityCapability(
          identity.operationalRunInstance.runId,
          { kind: "local" },
          undefined,
          () => true,
          undefined,
          undefined,
          true,
          {
            profileId: "bob",
            agentId: "main",
            sessionKey,
            sessionId: sessionKey,
            accountId: "default",
            to: "group-1",
            threadId: "topic-1",
          },
        ),
        "bob scope",
      );
      const call = (
        method: string,
        params: Record<string, unknown>,
        profile: string,
        runtime: Partial<AgentRuntimeIdentity> = {},
      ) =>
        invoke(method, params, {
          ...identity,
          turnSourceChannel: "telegram",
          turnSourceAccountId: "default",
          turnSourceTo: "group-1",
          turnSourceThreadId: "topic-1",
          ...runtime,
          cronCreatorAuthorityGrant: mintCronCreatorAuthorityGrant(
            profile === "bob" ? bobScope : scope,
            undefined,
            undefined,
            undefined,
            "requester",
            undefined,
            profile,
          ),
        });
      try {
        const list = await call("cron.list", { includeDisabled: true }, "alice");
        expect(list[0]).toBe(true);
        expect(list[1]).toMatchObject({ jobs: [expect.objectContaining({ id: alice.id })] });
        const delegated = await call("cron.get", { id: alice.id }, "alice", {
          agentId: "worker",
          sessionKey: "agent:worker:subagent:child",
          turnSourceTo: "different-runtime-route",
          turnSourceAccountId: "other",
        });
        expect(delegated[0]).toBe(true);
        expectDenied(await call("cron.get", { id: bob.id }, "alice"), "cron job not found");
        expectDenied(
          await call("cron.get", { id: aliceOtherTopic.id }, "alice"),
          "cron job not found",
        );
        expectDenied(
          await call("cron.remove", { id: aliceOtherTopic.id }, "alice"),
          "Automation not found",
        );
        expectDenied(await call("cron.remove", { id: bob.id }, "alice"), "Automation not found");
        for (const method of ["cron.bind"]) {
          const denied = await call(method, { id: alice.id }, "alice");
          expect(denied[0]).toBe(false);
          expect(denied[2]?.message).toMatch(
            /Caller automations allow only|missing scope: operator.admin/,
          );
        }
        const reminder = {
          ...jobInput,
          schedule: { kind: "at", at: "2030-01-01T00:00:00.000Z" },
          deleteAfterRun: true,
          sessionTarget: "current",
          sessionKey,
          payload: { kind: "agentTurn", message: "Reminder", toolsAllow: [] },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "group-1",
            accountId: "default",
            threadId: "topic-1",
          },
        };
        const created = await call("cron.add", reminder, "alice");
        expect(created[0], created[2]?.message).toBe(true);
        const createdId = (created[1] as { id: string }).id;
        expect(cron.getJob(createdId)).toMatchObject({
          ownerProfileId: "alice",
          createdActor: { type: "human", source: "profile", id: "alice" },
        });
        const recurring = await call(
          "cron.add",
          {
            ...reminder,
            deleteAfterRun: false,
            schedule: { kind: "every", everyMs: 60000 },
          },
          "alice",
        );
        expect(recurring[0], recurring[2]?.message).toBe(true);
        const recurringId = (recurring[1] as { id: string }).id;
        expect((await call("cron.get", { id: recurringId }, "alice"))[0]).toBe(true);
        expectDenied(await call("cron.get", { id: recurringId }, "bob"), "cron job not found");
        const disabled = await call(
          "cron.update",
          { id: recurringId, patch: { enabled: false } },
          "alice",
        );
        expect(disabled[0], disabled[2]?.message).toBe(true);
        expect((await call("cron.runs", { id: recurringId, limit: 1 }, "alice"))[0]).toBe(true);
        expect((await call("cron.remove", { id: recurringId }, "alice"))[0]).toBe(true);
        expectDenied(await call("cron.get", { id: createdId }, "bob"), "cron job not found");
        expectDenied(await call("cron.remove", { id: createdId }, "bob"), "Automation not found");
        expect((await call("cron.remove", { id: createdId }, "alice"))[0]).toBe(true);
        for (const bad of [
          { ...reminder, delivery: { ...reminder.delivery, to: "another-group" } },
          { ...reminder, delivery: { ...reminder.delivery, threadId: "another-topic" } },
          { ...reminder, sessionKey: "agent:main:other" },
          {
            ...reminder,
            payload: { kind: "agentTurn", message: "x", toolsAllowIsDefault: true, toolsAllow: [] },
          },
          { ...reminder, payload: { kind: "agentTurn", message: "x", toolsAllow: ["*"] } },
          { ...reminder, trigger: { script: "return true" } },
          { ...reminder, failureAlert: { after: 1, to: "other" } },
        ]) {
          expectDenied(await call("cron.add", bad, "alice"), "Caller automations require");
        }
        expect((await call("cron.remove", { id: alice.id }, "alice"))[0]).toBe(true);
        expect((await call("cron.get", { id: bob.id }, "bob"))[0]).toBe(true);
      } finally {
        revokeCronCreatorAuthorityRunScope(scope);
        revokeCronCreatorAuthorityRunScope(bobScope);
      }
    });
  });
});

it.each([
  {
    label: "one-shot reminder",
    schedule: { kind: "at", at: "2030-01-01T00:00:00.000Z" },
    tools: [],
  },
  {
    label: "tool-using recurring job",
    schedule: { kind: "every", everyMs: 60_000 },
    tools: ["read"],
  },
])("manages an accepted $label from a fresh nonowner topic turn", async ({ schedule, tools }) => {
  vi.stubEnv("OPENAI_API_KEY", "synthetic-reminder-fixture-key");
  await withCron(async ({ cron, tool, invoke }) => {
    const sessionKey = "agent:main:telegram:group:-1001234567890:topic:99";
    const sessionId = "reminder-topic-session";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: 1, visibility: "shared" },
    );
    let sequence = 0;
    const turn = async (
      profileId: string,
      args: Record<string, unknown>,
      route: { threadId?: string; accountId?: string } = {},
    ) => {
      const runId = "reminder-turn-" + ++sequence;
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const operator = createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.write"],
        assertCurrent: () => {},
      });
      const replyRoute = {
        channel: "telegram",
        to: "telegram:-1001234567890",
        accountId: route.accountId ?? "default",
        threadId: route.threadId ?? "99",
      };
      const personalReminder = resolvePersonalReminderOrigin({
        eligible: true,
        messageProvider: "telegram",
        operator,
        requesterProfileId: profileId,
        sessionKey,
        sessionId,
        replyRoute,
      });
      const factory = expectDefined(
        createChannelReminderAuthorityFactory({
          inherited: false,
          fresh: true,
          messageProvider: "telegram",
          senderId: profileId,
          accountId: replyRoute.accountId,
          cronOwner: {},
          isCurrentChannelOwner: () => false,
          personalReminder,
          operator,
        }),
        "reminder authority factory",
      );
      const scope = expectDefined(factory(runId), "fresh reminder scope");
      const identity: AgentRuntimeIdentity = {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...authority },
        turnSourceChannel: "telegram",
        turnSourceAccountId: replyRoute.accountId,
        turnSourceTo: replyRoute.to,
        turnSourceThreadId: replyRoute.threadId,
      };
      try {
        return await runWithCronCreatorAuthorityCapability(scope, () =>
          withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, () =>
            tool(identity, ["read"]).execute(runId, args),
          ),
        );
      } finally {
        revokeCronCreatorAuthorityRunScope(scope);
        releaseAgentRunDelegatedAuthority(authority);
      }
    };
    const created = await turn("alice", {
      action: "add",
      job: {
        name: "Personal reminder",
        schedule,
        sessionTarget: "current",
        payload: { kind: "agentTurn", message: "Reminder", toolsAllow: tools },
        delivery: { mode: "announce" },
      },
    });
    const id = (created.details as { id: string }).id;
    expect(cron.getJob(id)).toMatchObject({
      ownerProfileId: "alice",
      enabled: true,
      payload: { toolsAllow: tools },
    });
    expect((await turn("alice", { action: "list", includeDisabled: true })).details).toMatchObject({
      jobs: [expect.objectContaining({ id })],
      total: 1,
    });
    expect((await turn("alice", { action: "get", jobId: id })).details).toMatchObject({ id });
    await turn("alice", { action: "update", jobId: id, job: { enabled: false } });
    expect(cron.getJob(id)).toMatchObject({ enabled: false, payload: { toolsAllow: tools } });
    await expect(
      turn("alice", {
        action: "update",
        jobId: id,
        job: { payload: { toolsAllow: ["write"] } },
      }),
    ).rejects.toThrow(/cannot be carried from this creator turn/);
    expect(cron.getJob(id)).toMatchObject({ payload: { kind: "agentTurn", toolsAllow: tools } });
    for (const [profileId, route] of [
      ["bob", {}],
      ["alice", { threadId: "100" }],
      ["alice", { accountId: "other" }],
    ] as const) {
      expect(
        (await turn(profileId, { action: "list", includeDisabled: true }, route)).details,
      ).toMatchObject({ jobs: [], total: 0 });
      for (const action of ["get", "remove"]) {
        await expect(turn(profileId, { action, jobId: id }, route)).rejects.toThrow(/not found/);
      }
    }
    expect((await turn("alice", { action: "remove", jobId: id })).details).toMatchObject({
      removed: true,
    });
    expectDenied(await invoke("cron.get", { id }), "cron job not found");
  });
});
