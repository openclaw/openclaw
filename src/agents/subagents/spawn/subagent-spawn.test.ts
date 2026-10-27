import os from "node:os";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import {
  captureExternalSessionCommitGuard,
  prepareSessionSourceAuthority,
  type PreparedSessionSourceAuthority,
} from "../../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DispatchGatewayMethodInProcessOptions } from "../../../gateway/server-plugin-in-process-dispatch.types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import { installAcceptedSubagentGatewayMock } from "../../test-helpers/subagent-gateway.js";
import type { RegisterSubagentRunOptions } from "../registry/subagent-registry.types.js";
import type { SpawnSubagentContext, SpawnSubagentParams } from "./subagent-spawn-contract.js";
import { expectSharedPendingSpawnCapacity } from "./subagent-spawn.pending-capacity.test-support.js";
import {
  createConfigOverride,
  createSubagentRegistrationScopeForTest,
  inheritedSpawnCases,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
  supportedSpawnModelChoice,
} from "./subagent-spawn.test-helpers.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  prepareModelChoiceMock: vi.fn<typeof supportedSpawnModelChoice>(),
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  startQueuedSubagentRunMock: vi.fn(),
  settleFailedQueuedSubagentLaunchMock: vi.fn(),
  completeCollectorLaunchCleanupMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  dispatchGatewayMethodInProcessMock: vi.fn(),
  hasInProcessGatewayContextMock: vi.fn(),
  resolveAgentConfigMock: vi.fn(),
  resolveContextEngineMock: vi.fn(),
  countActiveRunsForSessionMock: vi.fn(),
  listSwarmRunsForGroupMock: vi.fn(),
  resolveSandboxRuntimeStatusMock: vi.fn<
    (params: { sessionKey?: string }) => {
      sandboxed: boolean;
      sandboxRequired: boolean;
      isolationSubject?: import("../../sandbox/types.js").SandboxIsolationSubject;
      createdActor?: import("../../../config/sessions/session-entry-provenance.js").SessionCreatedActor;
    }
  >(),
}));

let configOverride: Record<string, unknown>;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let closeSwarmScheduler: typeof import("../swarm/swarm-scheduler.js").closeSwarmScheduler;
let observeSwarmSchedulerWork: typeof import("../swarm/swarm-scheduler.lifecycle.test-support.js").observeSwarmSchedulerWork;
let schedulerWork: ReturnType<typeof observeSwarmSchedulerWork>;

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function gatewayRequestRecords(): Record<string, unknown>[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => requireRecord(call[0]));
}

function gatewayRequest(method: string): Record<string, unknown> {
  const request = gatewayRequestRecords().find((entry) => entry.method === method);
  return requireRecord(request);
}

function agentParams() {
  return requireRecord(gatewayRequest("agent").params);
}

function firstRegisteredSubagentRun(): Record<string, unknown> {
  return requireRecord(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]);
}
function mockDispatch(handlers: Record<string, (params: unknown) => unknown>) {
  hoisted.callGatewayMock.mockImplementation(
    async (request: { method: string; params?: unknown }) =>
      handlers[request.method]?.(request.params) ?? {},
  );
}

function expectNoChildSpawnSideEffects(): void {
  expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
}

const collectorContext = { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" };
function spawn(params: SpawnSubagentParams, ctx: SpawnSubagentContext = {}) {
  return spawnSubagentDirect(params, { agentSessionKey: "agent:main:main", ...ctx });
}
function spawnCollector(
  task: string,
  params: Partial<SpawnSubagentParams> = {},
  context: SpawnSubagentContext = {},
) {
  return spawn({ task, collect: true, ...params }, { ...collectorContext, ...context });
}
async function expectRefusedSpawn(
  params: Partial<SpawnSubagentParams>,
  error: string,
  context: SpawnSubagentContext = {},
  status = "error",
) {
  expect(await spawn({ task: "must not launch", ...params }, context)).toMatchObject({
    status,
    error: expect.stringContaining(error),
  });
  expectNoChildSpawnSideEffects();
}
function configureSwarm(swarm: boolean | Record<string, unknown> = true) {
  configOverride = createConfigOverride({ tools: { swarm } });
}
function captureStore() {
  let captured: Record<string, Record<string, unknown>> = {};
  installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
    onStore: (store) => {
      captured = store;
    },
  });
  return () => captured;
}
function configureWorker(main: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  configOverride = createConfigOverride({
    agents: {
      defaults: { workspace: os.tmpdir() },
      entries: {
        main: { workspace: "/tmp/workspace-main", ...main },
        worker: { workspace: "/tmp/workspace-worker" },
      },
    },
    ...extra,
  });
}

function replayCollectorInput() {
  return {
    task: "collect replay-safe evidence",
    collect: true,
    groupId: "swarm:replay",
    swarmLaunchReplayKey: "cm-restart:bridge:1",
    swarmLaunchRequestFingerprint: "sha256:request",
  };
}

function configureMain(defaults: Record<string, unknown>) {
  configOverride = createConfigOverride({
    agents: {
      defaults: { workspace: os.tmpdir(), ...defaults },
      entries: { main: { workspace: "/tmp/workspace-main" } },
    },
  });
}

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      ...hoisted,
      getRuntimeConfig: () => configOverride,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      resolveContextEngineMock: hoisted.resolveContextEngineMock,
      countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
      listSwarmRunsForGroup: hoisted.listSwarmRunsForGroupMock,
      resolveSandboxRuntimeStatus: hoisted.resolveSandboxRuntimeStatusMock,
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
    }));
    ({ closeSwarmScheduler } = await import("../swarm/swarm-scheduler.js"));
    ({ observeSwarmSchedulerWork } =
      await import("../swarm/swarm-scheduler.lifecycle.test-support.js"));
  });

  beforeEach(async () => {
    schedulerWork = observeSwarmSchedulerWork();
    await resetSubagentRegistryForTests();
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    hoisted.prepareModelChoiceMock.mockImplementation(supportedSpawnModelChoice);
    hoisted.startQueuedSubagentRunMock.mockResolvedValue(true);
    hoisted.settleFailedQueuedSubagentLaunchMock.mockResolvedValue(true);
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(false);
    hoisted.resolveContextEngineMock.mockResolvedValue({});
    hoisted.countActiveRunsForSessionMock.mockReturnValue(0);
    hoisted.listSwarmRunsForGroupMock.mockReturnValue([]);
    hoisted.resolveSandboxRuntimeStatusMock.mockReturnValue({
      sandboxed: false,
      sandboxRequired: false,
    });
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
    );
    configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);
    hoisted.loadSessionStoreMock.mockReturnValue({});

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  afterEach(async () => {
    try {
      await schedulerWork.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([false, true])(
    "preserves native source requirement %s through child launch",
    async (nativeSource) => {
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("parent authority retired");
        }
      };
      let forwarded: PreparedSessionSourceAuthority | undefined;
      hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
      hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(
        async (
          _method: string,
          _params: Record<string, unknown>,
          options?: DispatchGatewayMethodInProcessOptions,
        ) => {
          forwarded = await prepareSessionSourceAuthority(
            captureExternalSessionCommitGuard(options?.sessionMutationCommitGuard),
          );
          return { runId: "run-1", status: "accepted" };
        },
      );
      const assertActive = Object.assign(assertCurrent, {
        nativeSource,
        prepareSessionSource: async () => ({ nativeSource, checks: [], assertCurrent }),
      });
      const result = await spawn({ task: "preserve parent authority" }, { assertActive });
      expect(result.status).toBe("accepted");
      expect(forwarded?.nativeSource).toBe(nativeSource);
      current = false;
      expect(() => forwarded?.assertCurrent()).toThrow("parent authority retired");
      await forwarded?.release?.();
    },
  );

  it.each<[Partial<SpawnSubagentParams>, string, boolean?, SpawnSubagentContext?, string?]>([
    [
      { worktree: true, worktreeName: "codex/qa-telemetry-prompt-cache-20261016", collect: true },
      "worktree name must match [a-z0-9][a-z0-9-]{0,63}",
    ],
    [{ completionTarget: "parent", collect: true }, 'completionTarget="parent"'],
    [
      { completionTarget: "parent" },
      "existing requester session",
      false,
      { agentSessionKey: "agent:main:missing" },
    ],
    [{ collect: true }, "tools.swarm.enabled=true", false, collectorContext, "forbidden"],
    [{ collect: true }, "requesting run id", true],
    [{ collect: true, thread: true }, "mode=run and thread=false", true, collectorContext],
    [
      { collect: true, outputSchema: { type: "object", properties: "invalid" } },
      "Invalid sessions_spawn outputSchema",
      true,
      collectorContext,
    ],
  ])("rejects %j with %s before child effects", async (params, error, enabled, context, status) => {
    configureSwarm(enabled ?? false);
    const onSpawnEffectsStart = vi.fn();
    await expectRefusedSpawn(params, error, { ...context, onSpawnEffectsStart }, status);
    expect(onSpawnEffectsStart).not.toHaveBeenCalled();
  });

  it("rejects explicit same-agent targets when allowAgents excludes the requester", async () => {
    configOverride = createConfigOverride({
      agents: {
        entries: { "task-manager": { subagents: { allowAgents: ["planner"] } }, planner: {} },
      },
    });

    const result = await spawn(
      { task: "spawn myself explicitly", agentId: "task-manager" },
      { agentSessionKey: "agent:task-manager:main" },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toBe("agentId is not allowed for sessions_spawn (allowed: planner)");
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
  });

  it("defaults collector group id from requester session and requesting run", async () => {
    configureSwarm();
    const readStore = captureStore();

    const progressOrigin = {
      channel: "telegram",
      accountId: "default",
      to: "chat:123",
      threadId: "456",
    };
    const result = await spawnCollector(
      "collect evidence",
      { outputSchema: { type: "object", required: ["answer"] } },
      {
        agentChannel: progressOrigin.channel,
        agentAccountId: progressOrigin.accountId,
        agentTo: progressOrigin.to,
        agentThreadId: progressOrigin.threadId,
      },
    );

    expect(result.sessionKey).toBe(result.childSessionKey);
    expect(result).toMatchObject({
      status: "accepted",
      groupId: "swarm:agent:main:main:parent-run",
      expectsCompletionMessage: false,
    });
    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput).toMatchObject({ progressOrigin });
    expect(readStore()[result.childSessionKey!]).toMatchObject({
      swarmGroupId: "swarm:agent:main:main:parent-run",
      swarmCollector: true,
      swarmOutputSchema: { type: "object", required: ["answer"] },
    });
    await vi.waitFor(() => gatewayRequest("agent"));
    const request = agentParams();
    expect(request).toMatchObject({
      swarmCollector: true,
      swarmOutputSchema: { type: "object", required: ["answer"] },
    });
    for (const key of ["channel", "to", "accountId", "threadId"]) {
      expect(request).not.toHaveProperty(key);
    }
    await vi.waitFor(() =>
      expect(hoisted.startQueuedSubagentRunMock).toHaveBeenCalledWith(result.runId, "run-1"),
    );

    hoisted.listSwarmRunsForGroupMock.mockReturnValue([
      { ...registerInput, execution: { status: "running" } },
    ]);
    const second = await spawnCollector("collect parallel evidence");
    expect(second.status).toBe("accepted");
  });

  it("persists a host-reserved collector launch identity", async () => {
    configureSwarm();

    const result = await spawn(replayCollectorInput(), collectorContext);
    const otherRequesterResult = await spawn(replayCollectorInput(), {
      agentSessionKey: "agent:main:other",
      requesterRunId: "parent-run",
    });

    expect(result).toMatchObject({ status: "accepted", groupId: "swarm:replay" });
    expect(result.runId).toMatch(/^swarm_[0-9a-f]{32}$/u);
    expect(otherRequesterResult).toMatchObject({ status: "accepted" });
    expect(otherRequesterResult.runId).toMatch(/^swarm_[0-9a-f]{32}$/u);
    expect(otherRequesterResult.runId).not.toBe(result.runId);
    expect(firstRegisteredSubagentRun()).toMatchObject({
      runId: result.runId,
      swarmLaunchIdempotencyKey: result.runId,
      swarmLaunchReplayKey: "cm-restart:bridge:1",
      swarmLaunchRequestFingerprint: "sha256:request",
    });
    await vi.waitFor(() => expect(gatewayRequest("agent")).toBeDefined());
    expect(agentParams().idempotencyKey).toBe(result.runId);
  });

  it("carries explicit model authorization through a queued collector launch", async () => {
    configureSwarm();

    const result = await spawnCollector("collect with the requested model", {
      model: "openai/gpt-5.4",
    });

    expect(result).toMatchObject({ status: "accepted", modelApplied: true });
    const queuedLaunch = requireRecord(firstRegisteredSubagentRun().queuedLaunch);
    const persistedLaunchJson = JSON.stringify(queuedLaunch);
    const persistedLaunch: unknown = JSON.parse(persistedLaunchJson);
    expect(requireRecord(persistedLaunch).requesterRecovery).toEqual({});
    const queuedRequest = requireRecord(queuedLaunch.request);
    expect(queuedRequest).not.toHaveProperty("provider");
    expect(queuedRequest).not.toHaveProperty("model");
    expect(queuedLaunch).toMatchObject({
      authorization: { modelOverride: { provider: "openai", model: "gpt-5.4" } },
    });
    await vi.waitFor(() => expect(gatewayRequest("agent")).toBeDefined());
    expect(gatewayRequest("agent")).toMatchObject({
      scopes: ["operator.admin"],
      params: { provider: "openai", model: "gpt-5.4" },
    });
  });

  it.each([
    ["unavailable", "model not allowed: fixture/blocked"],
    ["throws", "sessions_spawn could not verify the selected model: configuration unavailable"],
    ["no-tools", "requires a tool-capable target model"],
  ] as const)("rejects model preparation before child effects (%s)", async (failure, error) => {
    if (failure === "no-tools") {
      configureSwarm();
      hoisted.prepareModelChoiceMock.mockImplementation(async (request) => {
        const choice = await supportedSpawnModelChoice(request);
        if (choice.kind !== "resolved") {
          throw new Error("Expected supported fixture model");
        }
        return { ...choice, model: { ...choice.model, compat: { supportsTools: false } } };
      });
    } else if (failure === "throws") {
      hoisted.prepareModelChoiceMock.mockRejectedValue(new Error("configuration unavailable"));
    } else {
      hoisted.prepareModelChoiceMock.mockResolvedValue({ kind: "unavailable", error });
    }
    await expectRefusedSpawn(
      failure === "no-tools"
        ? { model: "openai/no-tools", collect: true, outputSchema: { type: "object" } }
        : { model: "fixture/blocked" },
      error,
      failure === "no-tools" ? collectorContext : {},
    );
  });

  it.each(["unconfirmed", "publication", "indeterminate"] as const)(
    "retains collector capacity until rollback settles (%s)",
    async (mode) => {
      configureSwarm({ enabled: true, maxConcurrent: 1 });
      if (mode !== "indeterminate") {
        hoisted.startQueuedSubagentRunMock.mockResolvedValueOnce(false).mockResolvedValue(true);
      }
      const publication = createDeferred();
      const publicationEntered = createDeferred();
      const deleteEntered = createDeferred();
      const allowDeletion = createDeferred();
      const secondDispatched = createDeferred();
      let publicationPending = mode === "publication";
      let agentCalls = 0;
      let abortCalls = 0;
      if (mode === "publication") {
        hoisted.registerSubagentRunMock.mockImplementationOnce(
          (record: { runId: string }, options?: RegisterSubagentRunOptions) => {
            if (!options?.retainOwnership) {
              throw new Error("Expected retained collector registration");
            }
            options.retainOwnership(
              createSubagentRegistrationScopeForTest({
                canCleanupSession: () => !publicationPending,
                waitForRetirementPublication: () => {
                  if (!publicationPending) {
                    return undefined;
                  }
                  publicationEntered.resolve();
                  return publication.promise;
                },
                settleFailedLaunch: async (error) => {
                  await hoisted.settleFailedQueuedSubagentLaunchMock(record.runId, error);
                },
              }),
            );
          },
        );
      }
      mockDispatch({
        agent: (params) => {
          if (mode === "indeterminate") {
            const message = String(requireRecord(params).message);
            if (
              !message.includes("indeterminate-first") &&
              !message.includes("indeterminate-second")
            ) {
              return { runId: "unrelated" };
            }
          }
          agentCalls += 1;
          if (mode === "indeterminate" && agentCalls === 1) {
            throw new Error("launch response lost");
          }
          if (agentCalls === 2) {
            secondDispatched.resolve();
          }
          return { runId: mode === "indeterminate" ? "gateway-second" : `gateway-${agentCalls}` };
        },
        "chat.abort": () => {
          if (mode === "indeterminate") {
            return {};
          }
          abortCalls += 1;
          throw new Error("abort unavailable");
        },
        "sessions.delete": async () => {
          deleteEntered.resolve();
          if (mode === "unconfirmed") {
            throw new Error("delete unavailable");
          }
          await allowDeletion.promise;
          return {};
        },
      });
      try {
        const first = await spawnCollector(`${mode}-first`, { groupId: mode });
        const second = await spawnCollector(`${mode}-second`, { groupId: mode });
        if (mode === "publication") {
          await publicationEntered.promise;
          expect(agentCalls).toBe(1);
          expect(gatewayRequestRecords().some(({ method }) => method === "sessions.delete")).toBe(
            false,
          );
          publicationPending = false;
          publication.resolve();
          expect(
            await Promise.race([
              deleteEntered.promise.then(() => "cleanup"),
              secondDispatched.promise.then(() => "next dispatch"),
            ]),
          ).toBe("cleanup");
        } else {
          await deleteEntered.promise;
        }
        expect(agentCalls).toBe(1);
        expect(hoisted.settleFailedQueuedSubagentLaunchMock).not.toHaveBeenCalled();
        if (mode === "unconfirmed") {
          await closeSwarmScheduler();
          expect(abortCalls).toBe(1);
          expect(agentCalls).toBe(1);
          expect(hoisted.settleFailedQueuedSubagentLaunchMock).not.toHaveBeenCalled();
        } else {
          allowDeletion.resolve();
          await secondDispatched.promise;
          if (mode === "publication") {
            await vi.waitFor(() =>
              expect(hoisted.startQueuedSubagentRunMock).toHaveBeenCalledWith(
                second.runId,
                "gateway-2",
              ),
            );
            expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledWith(
              first.runId,
              expect.any(String),
            );
          } else {
            await vi.waitFor(() => expect(agentCalls).toBe(2));
            expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledOnce();
          }
        }
      } finally {
        publicationPending = false;
        publication.resolve();
        allowDeletion.resolve();
        await closeSwarmScheduler();
      }
    },
  );

  it("uses and validates tools.swarm.defaultAgentId for collector children", async () => {
    configureWorker(
      { subagents: { allowAgents: ["worker"] } },
      { tools: { swarm: { enabled: true, defaultAgentId: "worker" } } },
    );

    const result = await spawnCollector("collect as worker");

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:worker:subagent:/);

    configureSwarm({ enabled: true, defaultAgentId: "missing" });
    const rejected = await spawnCollector("collect as missing");
    expect(rejected.status).toBe("forbidden");
    expect(rejected.error).toContain("tools.swarm.defaultAgentId");
  });

  it("rejects the collector lifetime cap with its config-key error", async () => {
    configureSwarm({ enabled: true, maxChildrenPerGroup: 1, maxTotalPerGroup: 2 });
    hoisted.listSwarmRunsForGroupMock.mockReturnValueOnce([
      { runId: "done", collect: true, collectorCompletion: { status: "done" } },
      { runId: "failed", collect: true, collectorCompletion: { status: "failed" } },
    ]);
    const totalRejected = await spawnCollector("third lifetime child", { groupId: "group" });
    expect(totalRejected.status).toBe("forbidden");
    expect(totalRejected.error).toContain("tools.swarm.maxTotalPerGroup");
  });

  it("enforces group caps atomically across concurrent collector registration", async () => {
    configureSwarm({ enabled: true, maxChildrenPerGroup: 1 });
    hoisted.listSwarmRunsForGroupMock.mockImplementation(() =>
      hoisted.registerSubagentRunMock.mock.calls.map(([run]) => requireRecord(run)),
    );

    const results = await Promise.all([
      spawnCollector("first concurrent child", { groupId: "shared" }),
      spawnCollector("second concurrent child", { groupId: "shared" }),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["accepted", "forbidden"]);
    expect(results.find((result) => result.status === "forbidden")?.error).toContain(
      "tools.swarm.maxChildrenPerGroup",
    );
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("reconciles ambiguous dispatch (terminal=%s)", async (terminal) => {
    const accepted = { runId: "accepted-ambig-run", status: "in_flight" };
    const dispatch = vi.fn().mockRejectedValueOnce(new Error("gateway timeout after 60000ms"));
    if (!terminal) {
      dispatch.mockResolvedValueOnce({ ...accepted, admissionPending: true });
    }
    dispatch.mockResolvedValue(terminal ? { runId: "stopped-run", status: "timeout" } : accepted);
    hoisted.callGatewayMock.mockImplementation(async ({ method }: { method?: string }) =>
      method === "agent"
        ? dispatch()
        : terminal || method?.startsWith("sessions.")
          ? { ok: true }
          : {},
    );
    const result = await spawn({ task: "ambiguous child" });
    if (terminal) {
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("no active subagent run (status: timeout)"),
      });
      expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    } else {
      const requests = gatewayRequestRecords().filter((request) => request.method === "agent");
      expect(requests.map((request) => request.params)).toEqual(Array(3).fill(requests[0]?.params));
      expect(result).toMatchObject({
        status: "accepted",
        runId: "accepted-ambig-run",
        childSessionKey: expect.any(String),
      });
    }
  });

  it("shares pending child capacity between native and visible spawn paths", async ({ signal }) => {
    configureMain({ subagents: { maxChildrenPerAgent: 1 } });
    await expectSharedPendingSpawnCapacity({
      config: configOverride as OpenClawConfig,
      spawn,
      callGatewayMock: hoisted.callGatewayMock,
      countActiveRuns: hoisted.countActiveRunsForSessionMock,
      signal,
    });
  });

  it.each(["off", "all"] as const)(
    "uses the global requester sandbox mode %s for cross-agent spawns",
    async (sandboxMode) => {
      const readStore = captureStore();
      configureWorker({ sandbox: { mode: sandboxMode }, subagents: { allowAgents: ["worker"] } });
      configOverride = {
        ...configOverride,
        session: { scope: "global" },
        agents: { ...requireRecord(configOverride.agents), ownership: "explicit" },
      };

      hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(resolveSandboxRuntimeStatus);

      const result = await spawn(
        { task: "attribute worker run", agentId: "worker" },
        {
          agentSessionKey: "global",
          requesterAgentIdOverride: "main",
          sessionPermissionPolicy: { mode: "guarded", root: "/tmp/workspace-main" },
        },
      );

      if (sandboxMode === "all") {
        expect(result).toMatchObject({
          status: "forbidden",
          error: expect.stringContaining("cannot spawn unsandboxed"),
        });
        expectNoChildSpawnSideEffects();
        return;
      }
      expect(result.status).toBe("accepted");
      expect(result.childSessionKey).toMatch(/^agent:worker:subagent:/);
      expect(readStore()[result.childSessionKey!]).toMatchObject({
        permissionMode: "guarded",
        sessionRoot: resolveUserPath("/tmp/workspace-worker"),
      });
      expect(firstRegisteredSubagentRun()).toMatchObject({
        childSessionKey: result.childSessionKey,
        childAgentId: "worker",
        requesterSessionKey: "global",
        requesterAgentId: "main",
      });
    },
  );

  it.each([
    { required: false, source: "profile", sandbox: "inherit" },
    { required: true, source: "profile", sandbox: "require" },
  ] as const)(
    "inherits native child $source provenance without host session SQL ($required) with sandbox=$sandbox",
    async ({ required, source, sandbox }) => {
      await withOpenClawTestState({ prefix: "openclaw-spawn-required-parent-" }, async (state) => {
        const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
        const parentSessionKey = "agent:main:main";
        const actor = { type: "human", source, id: "profile-native-creator" } as const;
        const parent = await upsertSessionEntryCore(
          { agentId: "main", sessionKey: parentSessionKey, storePath },
          {
            sessionId: "parent-session",
            updatedAt: 1,
            createdVia: "operator",
            createdActor: actor,
            ...(required ? { sandbox: "required" } : {}),
          },
        );
        hoisted.loadSessionStoreMock.mockReturnValue({ [parentSessionKey]: parent });
        configOverride = createConfigOverride({
          session: { store: storePath },
          agents: {
            defaults: { sandbox: { mode: "off" } },
            entries: { main: { workspace: state.workspaceDir } },
          },
        });
        hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(resolveSandboxRuntimeStatus);
        const readStore = captureStore();

        const sql = observeHostDataSql();
        try {
          const result = await spawn(
            { task: "continue under the parent's isolation policy", sandbox },
            { agentSessionKey: parentSessionKey },
          );

          expect(result.status).toBe("accepted");
          const child = readStore()[result.childSessionKey!];
          expect(child).toMatchObject({ createdVia: "spawn", parentSessionKey });
          expect(child?.createdActor).toEqual(
            required
              ? { ...actor, delegatedBy: { type: "agent", id: "main" } }
              : { type: "agent", id: "main" },
          );
          expect(child?.sandbox).toBe(required ? "required" : undefined);
          expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
        } finally {
          sql.restore();
        }
      });
    },
  );

  it("rejects a split-key sandboxed requester spawning an unsandboxed native child via the explicit sandboxed flag", async () => {
    // The durable lineage key is unsandboxed; the active caller classification must win (#137779).
    await expectRefusedSpawn({}, "cannot spawn unsandboxed", { sandboxed: true }, "forbidden");
  });

  it.each(inheritedSpawnCases.preferences.filter(({ collect }) => collect))(
    "$name",
    async ({ task, requesterState, expected }) => {
      hoisted.loadSessionStoreMock.mockReturnValue({ "agent:main:main": requesterState });
      const readStore = captureStore();
      const result = await spawn({ task, collect: true }, collectorContext);
      expect(result.status).toBe("accepted");
      expect(readStore()[result.childSessionKey!]?.fastMode).toBe(expected);
    },
  );

  it("inherits requester selected-model thinking without a session or agent default", async () => {
    configureMain({ models: { "openai-codex/gpt-5.4": { params: { thinking: "low" } } } });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
      },
    });
    const readStore = captureStore();
    const result = await spawn({ task: "inherit requester thinking" });
    expect(result.status).toBe("accepted");
    expect(readStore()[result.childSessionKey!]?.thinkingLevel).toBe("low");
  });

  it("returns an error when the initial child patch fails", async () => {
    hoisted.updateSessionStoreMock.mockRejectedValueOnce(new Error("invalid model: bad-model"));
    const result = await spawn(
      { task: "verify failed child creation", model: "bad-model" },
      {
        agentSessionKey: "agent:main:main",
        completionOwnerKey: "agent:main:completion-owner",
        agentChannel: "discord",
      },
    );
    expect(result).toMatchObject({
      status: "error",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      error: expect.stringContaining("invalid model: bad-model"),
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
  });
});
