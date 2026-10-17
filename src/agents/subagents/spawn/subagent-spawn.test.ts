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
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { expectSharedPendingSpawnCapacity } from "./subagent-spawn.pending-capacity.test-support.js";
import {
  createConfigOverride,
  createSubagentRegistrationScopeForTest,
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

const {
  callGatewayMock: gateway,
  updateSessionStoreMock: updateStore,
  registerSubagentRunMock: registerRun,
  startQueuedSubagentRunMock: startQueued,
  settleFailedQueuedSubagentLaunchMock: settleFailed,
  prepareModelChoiceMock: prepareModel,
  listSwarmRunsForGroupMock: listGroupRuns,
  resolveSandboxRuntimeStatusMock: sandboxStatus,
} = hoisted;

let configOverride: Record<string, unknown>;
let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let closeSwarmScheduler: typeof import("../swarm/swarm-scheduler.js").closeSwarmScheduler;

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function gatewayRequestRecords(): Record<string, unknown>[] {
  return gateway.mock.calls.map((call) => requireRecord(call[0]));
}

function gatewayRequest(method: string): Record<string, unknown> {
  const request = gatewayRequestRecords().find((entry) => entry.method === method);
  return requireRecord(request);
}

function firstRegisteredSubagentRun(): Record<string, unknown> {
  return requireRecord(registerRun.mock.calls[0]?.[0]);
}

function expectNoChildSpawnSideEffects(includeStore = true): void {
  const mocks = [registerRun, gateway, hoisted.emitSessionLifecycleEventMock];
  if (includeStore) {
    mocks.push(updateStore);
  }
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const collectorContext = { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" };
function spawn(
  params: Omit<Parameters<typeof spawnSubagentDirect>[0], "task"> & { task?: string } = {},
  ctx: Parameters<typeof spawnSubagentDirect>[1] = {},
) {
  return spawnSubagentDirect(
    { task: "test task", ...params },
    { agentSessionKey: "agent:main:main", ...ctx },
  );
}
function captureStore() {
  let captured: Record<string, Record<string, unknown>> = {};
  installSessionStoreCaptureMock(updateStore, {
    onStore: (store) => {
      captured = store;
    },
  });
  return () => captured;
}

function configureSwarm(swarm: true | Record<string, unknown> = true) {
  configOverride = createConfigOverride({ tools: { swarm } });
}

function collect(task: string, params: Omit<Parameters<typeof spawn>[0], "task"> = {}) {
  return spawn({ task, collect: true, ...params }, collectorContext);
}

function configureAgents(
  defaults: Record<string, unknown> = {},
  main: Record<string, unknown> = {},
  agents: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
) {
  configOverride = createConfigOverride({
    ...config,
    agents: {
      defaults: { workspace: os.tmpdir(), ...defaults },
      entries: { main: { workspace: "/tmp/workspace-main", ...main } },
      ...agents,
    },
  });
}

function workerAgents(main: Record<string, unknown> = {}) {
  return {
    main: { workspace: "/tmp/workspace-main", subagents: { allowAgents: ["worker"] }, ...main },
    worker: { workspace: "/tmp/workspace-worker" },
  };
}

function createGate() {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    entered: entered.promise,
    release: released.resolve,
    wait: () => {
      entered.resolve();
      return released.promise;
    },
  };
}

function rejectedCollectorGateway(
  onDelete: () => Promise<unknown>,
  onAgent = (_count: number) => {},
) {
  configureSwarm({ enabled: true, maxConcurrent: 1 });
  startQueued.mockResolvedValueOnce(false).mockResolvedValue(true);
  const calls = { agent: 0, abort: 0 };
  gateway.mockImplementation(async (request: { method?: string }) => {
    switch (request.method) {
      case "agent":
        onAgent(++calls.agent);
        return { runId: `gateway-${calls.agent}` };
      case "chat.abort":
        calls.abort++;
        throw new Error("abort unavailable");
      case "sessions.delete":
        return (await onDelete()) ?? {};
      default:
        return {};
    }
  });
  return calls;
}

function expectRejection(
  result: Awaited<ReturnType<typeof spawn>>,
  status: "error" | "forbidden",
  error: string,
) {
  expect(result).toMatchObject({ status, error: expect.stringContaining(error) });
}

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      ...hoisted,
      getRuntimeConfig: () => configOverride,
      resolveAgentConfig: hoisted.resolveAgentConfigMock,
      resolveContextEngineMock: hoisted.resolveContextEngineMock,
      countActiveRunsForSession: hoisted.countActiveRunsForSessionMock,
      listSwarmRunsForGroup: listGroupRuns,
      resolveSandboxRuntimeStatus: sandboxStatus,
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
    }));
    ({ closeSwarmScheduler } = await import("../swarm/swarm-scheduler.js"));
  });

  beforeEach(async () => {
    swarmSchedulerTesting.reset();
    await resetSubagentRegistryForTests();
    for (const mock of Object.values(hoisted)) {
      mock.mockReset();
    }
    prepareModel.mockImplementation(supportedSpawnModelChoice);
    startQueued.mockResolvedValue(true);
    settleFailed.mockResolvedValue(true);
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(false);
    hoisted.resolveContextEngineMock.mockResolvedValue({});
    hoisted.countActiveRunsForSessionMock.mockReturnValue(0);
    listGroupRuns.mockReturnValue([]);
    sandboxStatus.mockReturnValue({
      sandboxed: false,
      sandboxRequired: false,
    });
    hoisted.resolveAgentConfigMock.mockImplementation(
      (cfg: OpenClawConfig, agentId: string) => cfg.agents?.entries?.[agentId],
    );
    configOverride = createConfigOverride();
    installAcceptedSubagentGatewayMock(gateway);
    hoisted.loadSessionStoreMock.mockReturnValue({});

    updateStore.mockImplementation(
      async (
        _path: string,
        mutate: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store = {};
        await mutate(store);
        return store;
      },
    );
  });

  afterEach(() => {
    swarmSchedulerTesting.reset();
    vi.unstubAllEnvs();
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
      const result = await spawn({}, { assertActive });
      expect(result.status).toBe("accepted");
      expect(forwarded?.nativeSource).toBe(nativeSource);
      current = false;
      expect(() => forwarded?.assertCurrent()).toThrow("parent authority retired");
      await forwarded?.release?.();
    },
  );

  it.each([
    [{ completionTarget: "parent", collect: true }, {}, 'completionTarget="parent"'],
    [
      { completionTarget: "parent" },
      { agentSessionKey: "agent:main:missing" },
      "existing requester session",
    ],
    // Active classification beats the unsandboxed durable lineage key (#137779).
    [{}, { sandboxed: true }, "cannot spawn unsandboxed"],
  ] as const)("rejects private spawn %j from %j: %s", async (params, ctx, error) => {
    const result = await spawn(params, ctx);
    expectRejection(result, "sandboxed" in ctx ? "forbidden" : "error", error);
    expectNoChildSpawnSideEffects();
  });

  it.each([
    [false, collectorContext, {}, "tools.swarm.enabled=true", "forbidden", "gateway"],
    [true, {}, {}, "requesting run id", "error", undefined],
    [true, collectorContext, { thread: true }, "mode=run and thread=false", "error", "gateway"],
    [
      true,
      collectorContext,
      { outputSchema: { type: "object", properties: "invalid" } },
      "Invalid sessions_spawn outputSchema",
      "error",
      "store",
    ],
  ] as const)(
    "validates collector (enabled=%s, context=%j, params=%j): %s",
    async (enabled, ctx, params, error, status, untouched) => {
      configOverride = createConfigOverride({ tools: { swarm: enabled } });
      expectRejection(await spawn({ collect: true, ...params }, ctx), status, error);
      if (untouched === "gateway") {
        expect(gatewayRequestRecords()).toEqual([]);
      }
      if (untouched === "store") {
        expect(updateStore).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects explicit same-agent targets when allowAgents excludes the requester", async () => {
    configOverride = createConfigOverride({
      agents: {
        entries: { "task-manager": { subagents: { allowAgents: ["planner"] } }, planner: {} },
      },
    });

    const result = await spawn(
      { agentId: "task-manager" },
      { agentSessionKey: "agent:task-manager:main" },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toBe("agentId is not allowed for sessions_spawn (allowed: planner)");
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
  });

  it("defaults collector group id from requester session and requesting run", async () => {
    configureSwarm();
    const readStore = captureStore();

    const result = await spawn(
      {
        collect: true,
        outputSchema: { type: "object", required: ["answer"] },
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "telegram",
        agentAccountId: "default",
        agentTo: "chat:123",
        agentThreadId: "456",
        requesterRunId: "parent-run",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      sessionKey: result.childSessionKey,
      expectsCompletionMessage: false,
    });
    const registerInput = firstRegisteredSubagentRun();
    expect(registerInput).toMatchObject({
      runId: result.runId,
      collect: true,
      queued: true,
      expectsCompletionMessage: false,
      groupId: "swarm:agent:main:main:parent-run",
      outputSchema: { type: "object", required: ["answer"] },
      progressOrigin: {
        channel: "telegram",
        accountId: "default",
        to: "chat:123",
        threadId: "456",
      },
    });
    expect(readStore()[result.childSessionKey!]).toMatchObject({
      swarmGroupId: "swarm:agent:main:main:parent-run",
      swarmCollector: true,
      swarmOutputSchema: { type: "object", required: ["answer"] },
    });
    await vi.waitFor(() =>
      expect(gatewayRequest("agent")).toEqual(expect.objectContaining({ method: "agent" })),
    );
    expect(gatewayRequest("agent")).toMatchObject({
      params: {
        swarmCollector: true,
        swarmOutputSchema: { type: "object", required: ["answer"] },
      },
    });
    const agentParams = requireRecord(gatewayRequest("agent").params);
    for (const key of ["channel", "to", "accountId", "threadId"]) {
      expect(agentParams).not.toHaveProperty(key);
    }
    await vi.waitFor(() => expect(startQueued).toHaveBeenCalledWith(result.runId, "run-1"));

    listGroupRuns.mockReturnValue([{ ...registerInput, execution: { status: "running" } }]);
    const second = await collect("collect parallel evidence");
    expect(second.status).toBe("accepted");
  });

  it("persists a host-reserved collector launch identity", async () => {
    configureSwarm();
    const request = {
      collect: true,
      groupId: "swarm:replay",
      swarmLaunchReplayKey: "cm-restart:bridge:1",
      swarmLaunchRequestFingerprint: "sha256:request",
    };
    const result = await spawn(request, collectorContext);
    const otherRequesterResult = await spawn(request, {
      agentSessionKey: "agent:main:other",
      requesterRunId: "parent-run",
    });

    expect(result).toMatchObject({ status: "accepted" });
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
    expect(requireRecord(gatewayRequest("agent").params).idempotencyKey).toBe(result.runId);
  });

  it("carries explicit model authorization through a queued collector launch", async () => {
    configureSwarm();
    const result = await collect("collect with the requested model", { model: "openai/gpt-5.4" });

    expect(result).toMatchObject({ status: "accepted", modelApplied: true });
    const queuedLaunch = requireRecord(firstRegisteredSubagentRun().queuedLaunch);
    const queuedRequest = requireRecord(queuedLaunch.request);
    expect(queuedRequest).not.toHaveProperty("provider");
    expect(queuedRequest).not.toHaveProperty("model");
    expect(queuedLaunch).toMatchObject({
      authorization: {
        modelOverride: { provider: "openai", model: "gpt-5.4" },
      },
    });
    await vi.waitFor(() => expect(gatewayRequest("agent")).toBeDefined());
    expect(gatewayRequest("agent")).toMatchObject({
      scopes: ["operator.admin"],
      params: { provider: "openai", model: "gpt-5.4" },
    });
  });

  it("returns the model owner's policy refusal before creating child state", async () => {
    const model = "fixture/blocked";
    const error = "model not allowed: fixture/blocked";
    prepareModel.mockResolvedValue({ kind: "unavailable", error });
    const result = await spawn({ model });
    expectRejection(result, "error", error);
    expect(prepareModel).toHaveBeenCalledWith({
      cfg: configOverride,
      agentId: "main",
      workspaceDir: resolveUserPath("/tmp/workspace-main"),
      raw: model,
      source: "override",
    });
    expectNoChildSpawnSideEffects();
  });

  it("rejects failed model preparation without creating child state", async () => {
    prepareModel.mockRejectedValue(new Error("configuration unavailable"));
    const result = await spawn({ model: "openai/gpt-5.4" });
    expectRejection(
      result,
      "error",
      "sessions_spawn could not verify the selected model: configuration unavailable",
    );
    expectNoChildSpawnSideEffects();
  });

  it("holds an unconfirmed collector slot for shutdown without retrying dispatch", async () => {
    const cleanupFailed = createDeferred();
    const calls = rejectedCollectorGateway(async () => {
      cleanupFailed.resolve();
      throw new Error("delete unavailable");
    });

    await collect("stop-confirmation-first", { groupId: "stop-confirmation" });
    await collect("stop-confirmation-second", { groupId: "stop-confirmation" });

    await cleanupFailed.promise;
    await closeSwarmScheduler();
    expect(calls).toEqual({ abort: 1, agent: 1 });
    expect(settleFailed).not.toHaveBeenCalled();
  });

  it("retains the collector slot through publication and rollback termination", async () => {
    const publication = createGate();
    const deletion = createGate();
    const secondDispatched = createDeferred();
    let publicationPending = true;
    registerRun.mockImplementationOnce(
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
              return publication.wait();
            },
            settleFailedLaunch: async (error) => {
              await settleFailed(record.runId, error);
            },
          }),
        );
      },
    );
    const calls = rejectedCollectorGateway(deletion.wait, (count) => {
      if (count === 2) {
        secondDispatched.resolve();
      }
    });
    try {
      const first = await collect("publication-first", { groupId: "publication-rollback" });
      const second = await collect("publication-second", { groupId: "publication-rollback" });
      await publication.entered;
      expect(calls.agent).toBe(1);
      expect(gateway.mock.calls.some(([request]) => request.method === "sessions.delete")).toBe(
        false,
      );
      publicationPending = false;
      publication.release();
      expect(
        await Promise.race([
          deletion.entered.then(() => "cleanup"),
          secondDispatched.promise.then(() => "next dispatch"),
        ]),
      ).toBe("cleanup");
      expect(calls.agent).toBe(1);
      expect(settleFailed).not.toHaveBeenCalled();
      deletion.release();
      await secondDispatched.promise;
      await vi.waitFor(() => expect(startQueued).toHaveBeenCalledWith(second.runId, "gateway-2"));
      expect(settleFailed).toHaveBeenCalledWith(first.runId, expect.any(String));
    } finally {
      publicationPending = false;
      publication.release();
      deletion.release();
      await closeSwarmScheduler();
    }
  });

  it("holds the collector slot while an indeterminate launch session is deleted", async () => {
    configureSwarm({ enabled: true, maxConcurrent: 1 });
    let agentCalls = 0;
    const deletion = createGate();
    gateway.mockImplementation(async (request: { method?: string; params?: unknown }) => {
      if (request.method === "agent") {
        const message = String(requireRecord(request.params).message);
        if (!message.includes("indeterminate-first") && !message.includes("indeterminate-second")) {
          return { runId: "unrelated" };
        }
        agentCalls += 1;
        if (agentCalls === 1) {
          throw new Error("launch response lost");
        }
        return { runId: "gateway-second" };
      }
      if (request.method === "sessions.delete") {
        await deletion.wait();
      }
      return {};
    });

    await collect("indeterminate-first", { groupId: "indeterminate" });
    await collect("indeterminate-second", { groupId: "indeterminate" });

    await deletion.entered;
    expect(agentCalls).toBe(1);
    expect(settleFailed).not.toHaveBeenCalled();
    deletion.release();
    await vi.waitFor(() => expect(agentCalls).toBe(2));
    expect(settleFailed).toHaveBeenCalledOnce();
  });

  it("uses and validates tools.swarm.defaultAgentId for collector children", async () => {
    configureAgents(
      {},
      {},
      { entries: workerAgents() },
      {
        tools: { swarm: { enabled: true, defaultAgentId: "worker" } },
      },
    );

    const result = await collect("collect as worker");

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:worker:subagent:/);

    configureSwarm({ enabled: true, defaultAgentId: "missing" });
    const rejected = await collect("collect as missing");
    expectRejection(rejected, "forbidden", "tools.swarm.defaultAgentId");
  });

  it("rejects collector live and lifetime caps with config-key errors", async () => {
    configureSwarm({ enabled: true, maxChildrenPerGroup: 1, maxTotalPerGroup: 2 });
    listGroupRuns.mockReturnValueOnce([{ runId: "live", collect: true, groupId: "group" }]);
    const liveRejected = await collect("second live child", { groupId: "group" });
    expectRejection(liveRejected, "forbidden", "tools.swarm.maxChildrenPerGroup");
    expect(listGroupRuns).toHaveBeenLastCalledWith("group", "agent:main:main", "main");

    listGroupRuns.mockReturnValueOnce([
      { runId: "done", collect: true, collectorCompletion: { status: "done" } },
      { runId: "failed", collect: true, collectorCompletion: { status: "failed" } },
    ]);
    const totalRejected = await collect("third lifetime child", { groupId: "group" });
    expectRejection(totalRejected, "forbidden", "tools.swarm.maxTotalPerGroup");
  });

  it("enforces group caps atomically across concurrent collector registration", async () => {
    configureSwarm({ enabled: true, maxChildrenPerGroup: 1 });
    listGroupRuns.mockImplementation(() =>
      registerRun.mock.calls.map(([run]) => requireRecord(run)),
    );

    const results = await Promise.all([
      collect("first concurrent child", { groupId: "shared" }),
      collect("second concurrent child", { groupId: "shared" }),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["accepted", "forbidden"]);
    expect(results.find((result) => result.status === "forbidden")?.error).toContain(
      "tools.swarm.maxChildrenPerGroup",
    );
    expect(registerRun).toHaveBeenCalledTimes(1);
  });

  it.each(["in_flight", "timeout"] as const)(
    "reconciles an ambiguous dispatch to %s",
    async (status) => {
      let dispatchAttempts = 0;
      gateway.mockImplementation(async (request: { method?: string; timeoutMs?: number }) => {
        if (request.method === "agent") {
          dispatchAttempts += 1;
          if (dispatchAttempts === 1) {
            throw new Error("gateway timeout after 60000ms");
          }
          if (status === "timeout") {
            return { runId: "stopped-run", status };
          }
          if (dispatchAttempts === 2) {
            return { runId: "accepted-ambig-run", status: "in_flight", admissionPending: true };
          }
          return { runId: "accepted-ambig-run", status: "in_flight" };
        }
        return status === "timeout" || request.method?.startsWith("sessions.") ? { ok: true } : {};
      });
      const context = { agentSessionKey: "agent:main:main" };

      const result = await spawn(
        { task: status === "timeout" ? "ambiguous terminal child" : "ambiguous child" },
        context,
      );

      if (status === "timeout") {
        expect(dispatchAttempts).toBe(2);
        expectRejection(result, "error", "no active subagent run (status: timeout)");
        expect(registerRun).not.toHaveBeenCalled();
        return;
      }
      expect(dispatchAttempts).toBe(3);
      const agentRequests = gatewayRequestRecords().filter((request) => request.method === "agent");
      expect(agentRequests.map((request) => request.params)).toEqual([
        agentRequests[0]?.params,
        agentRequests[0]?.params,
        agentRequests[0]?.params,
      ]);
      expect(agentRequests.slice(1).map((request) => request.timeoutMs)).toEqual([800, 800]);
      expect(result).toMatchObject({
        status: "accepted",
        runId: "accepted-ambig-run",
        childSessionKey: expect.any(String),
      });
      expect(registerRun).toHaveBeenCalledTimes(1);
    },
  );

  it("shares pending child capacity between native and visible spawn paths", async ({ signal }) => {
    configureAgents({ subagents: { maxChildrenPerAgent: 1 } });
    await expectSharedPendingSpawnCapacity({
      config: configOverride as OpenClawConfig,
      spawn,
      callGatewayMock: gateway,
      countActiveRuns: hoisted.countActiveRunsForSessionMock,
      signal,
    });
  });

  it("rejects schema collection for a model that cannot call tools", async () => {
    configureSwarm();
    prepareModel.mockImplementation(async (request) => {
      const choice = await supportedSpawnModelChoice(request);
      if (choice.kind !== "resolved") {
        throw new Error("Expected supported fixture model");
      }
      return { ...choice, model: { ...choice.model, compat: { supportsTools: false } } };
    });

    const rejected = await collect("structured result", {
      model: "openai/no-tools",
      outputSchema: { type: "object" },
    });
    expectRejection(rejected, "error", "requires a tool-capable target model");
    expect(prepareModel).toHaveBeenCalledOnce();
    expect(updateStore).not.toHaveBeenCalled();
    expect(registerRun).not.toHaveBeenCalled();
  });

  it.each(["off", "all"] as const)(
    "uses the global requester sandbox mode %s for cross-agent spawns",
    async (sandboxMode) => {
      const readStore = captureStore();
      configureAgents(
        {},
        {},
        {
          ownership: "explicit",
          entries: workerAgents({ sandbox: { mode: sandboxMode } }),
        },
        { session: { scope: "global" } },
      );

      sandboxStatus.mockImplementation(resolveSandboxRuntimeStatus);

      const result = await spawn(
        { agentId: "worker" },
        {
          agentSessionKey: "global",
          requesterAgentIdOverride: "main",
          sessionPermissionPolicy: { mode: "guarded", root: "/tmp/workspace-main" },
        },
      );

      if (sandboxMode === "all") {
        expectRejection(result, "forbidden", "cannot spawn unsandboxed");
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
        sandboxStatus.mockImplementation(resolveSandboxRuntimeStatus);
        const readStore = captureStore();

        const sql = observeHostDataSql();
        try {
          const result = await spawn({ sandbox }, { agentSessionKey: parentSessionKey });

          expect(result.status).toBe("accepted");
          const child = readStore()[result.childSessionKey!];
          expect(child).toMatchObject({ createdVia: "spawn", parentSessionKey });
          expect(child?.createdActor).toEqual(required ? actor : { type: "agent", id: "main" });
          expect(child?.sandbox).toBe(required ? "required" : undefined);
          expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
        } finally {
          sql.restore();
        }
      });
    },
  );

  it("inherits requester fast mode for collector children", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({ "agent:main:main": { fastMode: "auto" } });
    const readStore = captureStore();
    const result = await collect("inherit fast mode");
    expect(result.status).toBe("accepted");
    expect(readStore()[result.childSessionKey!]?.fastMode).toBe("auto");
  });

  it("inherits requester selected-model thinking without a session or agent default", async () => {
    configureAgents({ models: { "openai-codex/gpt-5.4": { params: { thinking: "low" } } } });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
      },
    });
    const readStore = captureStore();
    const result = await spawn({});
    expect(result.status).toBe("accepted");
    expect(readStore()[result.childSessionKey!]?.thinkingLevel).toBe("low");
  });

  it("returns an error when the initial child patch fails", async () => {
    updateStore.mockRejectedValueOnce(new Error("invalid model: bad-model"));
    const result = await spawn(
      { model: "bad-model" },
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
    expect(updateStore).toHaveBeenCalledOnce();
    expectNoChildSpawnSideEffects(false);
  });
});
