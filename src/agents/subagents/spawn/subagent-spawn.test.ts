import os from "node:os";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
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

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function gatewayRequestRecords(): Record<string, unknown>[] {
  return hoisted.callGatewayMock.mock.calls.map((call) => requireRecord(call[0]));
}

function gatewayRequest(method: string): Record<string, unknown> {
  const request = gatewayRequestRecords().find((entry) => entry.method === method);
  return requireRecord(request);
}

function firstRegisteredSubagentRun(): Record<string, unknown> {
  return requireRecord(hoisted.registerSubagentRunMock.mock.calls[0]?.[0]);
}

function expectNoChildSpawnSideEffects(): void {
  expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
  expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
}

const collectorContext = { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" };
function spawn(
  params: Parameters<typeof spawnSubagentDirect>[0],
  ctx: Parameters<typeof spawnSubagentDirect>[1] = {},
) {
  return spawnSubagentDirect(params, { agentSessionKey: "agent:main:main", ...ctx });
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
  });

  beforeEach(async () => {
    swarmSchedulerTesting.reset();
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

  afterEach(() => {
    swarmSchedulerTesting.reset();
    vi.unstubAllEnvs();
  });

  it.each([{ collect: true }])(
    "rejects unsupported private completion combinations before child effects: %j",
    async (options) => {
      const result = await spawn({ task: "private work", completionTarget: "parent", ...options });
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining('completionTarget="parent"'),
      });
      expectNoChildSpawnSideEffects();
    },
  );

  it("rejects private completion without an existing parent incarnation", async () => {
    const result = await spawn(
      { task: "private work", completionTarget: "parent" },
      { agentSessionKey: "agent:main:missing" },
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("existing requester session"),
    });
    expectNoChildSpawnSideEffects();
  });

  it("rejects direct swarm parameters while tools.swarm is disabled", async () => {
    configOverride = createConfigOverride({ tools: { swarm: false } });
    const result = await spawn({ task: "collect", collect: true }, collectorContext);

    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("tools.swarm.enabled=true"),
    });
    expect(gatewayRequestRecords()).toEqual([]);
  });

  it("requires a requesting run id when a collector omits groupId", async () => {
    configOverride = createConfigOverride({ tools: { swarm: true } });

    const result = await spawn({ task: "missing default group identity", collect: true });

    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("requesting run id"),
    });
  });

  it.each([{ thread: true }])(
    "rejects interactive collector mode at the direct spawn boundary",
    async (params) => {
      configOverride = createConfigOverride({ tools: { swarm: true } });

      const result = await spawn(
        { task: "collect once", collect: true, ...params },
        collectorContext,
      );

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("mode=run and thread=false"),
      });
      expect(gatewayRequestRecords()).toEqual([]);
    },
  );

  it("rejects explicit same-agent targets when allowAgents excludes the requester", async () => {
    configOverride = createConfigOverride({
      agents: {
        entries: { "task-manager": { subagents: { allowAgents: ["planner"] } }, planner: {} },
      },
    });

    const result = await spawn(
      {
        task: "spawn myself explicitly",
        agentId: "task-manager",
      },
      {
        agentSessionKey: "agent:task-manager:main",
      },
    );

    expect(result.status).toBe("forbidden");
    expect(result.error).toBe("agentId is not allowed for sessions_spawn (allowed: planner)");
    expect(gatewayRequestRecords().some((request) => request.method === "agent")).toBe(false);
  });

  it("defaults collector group id from requester session and requesting run", async () => {
    configOverride = createConfigOverride({ tools: { swarm: true } });
    const readStore = captureStore();

    const result = await spawn(
      {
        task: "collect evidence",
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

    expect(result.status).toBe("accepted");
    expect(result.sessionKey).toBe(result.childSessionKey);
    expect(result.expectsCompletionMessage).toBe(false);
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
    expect(agentParams).not.toHaveProperty("channel");
    expect(agentParams).not.toHaveProperty("to");
    expect(agentParams).not.toHaveProperty("accountId");
    expect(agentParams).not.toHaveProperty("threadId");
    await vi.waitFor(() =>
      expect(hoisted.startQueuedSubagentRunMock).toHaveBeenCalledWith(result.runId, "run-1"),
    );

    hoisted.listSwarmRunsForGroupMock.mockReturnValue([
      { ...registerInput, execution: { status: "running" } },
    ]);
    const second = await spawn(
      { task: "collect parallel evidence", collect: true },
      collectorContext,
    );
    expect(second.status).toBe("accepted");
  });

  it("persists a host-reserved collector launch identity", async () => {
    configOverride = createConfigOverride({ tools: { swarm: true } });

    const result = await spawn(
      {
        task: "collect replay-safe evidence",
        collect: true,
        groupId: "swarm:replay",
        swarmLaunchReplayKey: "cm-restart:bridge:1",
        swarmLaunchRequestFingerprint: "sha256:request",
      },
      collectorContext,
    );
    const otherRequesterResult = await spawn(
      {
        task: "collect replay-safe evidence",
        collect: true,
        groupId: "swarm:replay",
        swarmLaunchReplayKey: "cm-restart:bridge:1",
        swarmLaunchRequestFingerprint: "sha256:request",
      },
      { agentSessionKey: "agent:main:other", requesterRunId: "parent-run" },
    );

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
    configOverride = createConfigOverride({ tools: { swarm: true } });

    const result = await spawn(
      {
        task: "collect with the requested model",
        model: "openai/gpt-5.4",
        collect: true,
      },
      collectorContext,
    );

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

  it.each([
    {
      name: "policy refusal",
      model: "fixture/blocked",
      error: "model not allowed: fixture/blocked",
    },
  ])("returns the model owner's $name before creating child state", async ({ model, error }) => {
    hoisted.prepareModelChoiceMock.mockResolvedValue({ kind: "unavailable", error });
    const result = await spawn({ task: "validate before launch", model });
    expect(result.status).toBe("error");
    expect(result.error).toContain(error);
    expect(hoisted.prepareModelChoiceMock).toHaveBeenCalledWith({
      cfg: configOverride,
      agentId: "main",
      workspaceDir: resolveUserPath("/tmp/workspace-main"),
      raw: model,
      source: "override",
    });
    expectNoChildSpawnSideEffects();
  });

  it("rejects failed model preparation without creating child state", async () => {
    hoisted.prepareModelChoiceMock.mockRejectedValue(new Error("configuration unavailable"));
    const result = await spawn({ task: "validate before launch", model: "openai/gpt-5.4" });
    expect(result.status).toBe("error");
    expect(result.error).toContain(
      "sessions_spawn could not verify the selected model: configuration unavailable",
    );
    expectNoChildSpawnSideEffects();
  });

  it("holds the collector slot until an accepted run is confirmed stopped", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    });
    hoisted.startQueuedSubagentRunMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    let stopAllowed = false;
    let agentCalls = 0;
    let abortCalls = 0;
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "agent") {
          agentCalls += 1;
          return { runId: `gateway-${agentCalls}` };
        }
        if (request.method === "chat.abort") {
          abortCalls += 1;
          if (!stopAllowed) {
            throw new Error("abort unavailable");
          }
          return {
            aborted: true,
            runIds: [requireRecord(request.params).runId],
          };
        }
        if (request.method === "sessions.delete") {
          throw new Error("delete unavailable");
        }
        return {};
      },
    );

    const first = await spawn(
      { task: "stop-confirmation-first", collect: true, groupId: "stop-confirmation" },
      collectorContext,
    );
    const second = await spawn(
      { task: "stop-confirmation-second", collect: true, groupId: "stop-confirmation" },
      collectorContext,
    );

    await vi.waitFor(() => expect(abortCalls).toBeGreaterThan(0));
    expect(agentCalls).toBe(1);
    stopAllowed = true;
    await vi.waitFor(() => expect(agentCalls).toBe(2));
    await vi.waitFor(() =>
      expect(hoisted.startQueuedSubagentRunMock).toHaveBeenCalledWith(second.runId, "gateway-2"),
    );
    expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledWith(
      first.runId,
      expect.any(String),
    );
  });

  it("retains the collector slot through publication and retrying rollback termination", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    });
    hoisted.startQueuedSubagentRunMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    const publication = createDeferred();
    const waitEntered = createDeferred();
    const retryEntered = createDeferred();
    const allowDeletion = createDeferred();
    const secondDispatched = createDeferred();
    let publicationPending = true;
    let agentCalls = 0;
    let deleteCalls = 0;
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
              waitEntered.resolve();
              return publication.promise;
            },
            settleFailedLaunch: async (error) => {
              await hoisted.settleFailedQueuedSubagentLaunchMock(record.runId, error);
            },
          }),
        );
      },
    );
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        agentCalls += 1;
        if (agentCalls === 2) {
          secondDispatched.resolve();
        }
        return { runId: `gateway-${agentCalls}` };
      }
      if (request.method === "chat.abort") {
        throw new Error("abort unavailable");
      }
      if (request.method === "sessions.delete") {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          throw new Error("transient guarded deletion failure");
        }
        retryEntered.resolve();
        await allowDeletion.promise;
      }
      return {};
    });
    try {
      const first = await spawn(
        { task: "publication-first", collect: true, groupId: "publication-rollback" },
        collectorContext,
      );
      const second = await spawn(
        { task: "publication-second", collect: true, groupId: "publication-rollback" },
        collectorContext,
      );
      await waitEntered.promise;
      expect(agentCalls).toBe(1);
      expect(deleteCalls).toBe(0);
      publicationPending = false;
      publication.resolve();
      expect(
        await Promise.race([
          retryEntered.promise.then(() => "cleanup retry"),
          secondDispatched.promise.then(() => "next dispatch"),
        ]),
      ).toBe("cleanup retry");
      expect(agentCalls).toBe(1);
      expect(hoisted.settleFailedQueuedSubagentLaunchMock).not.toHaveBeenCalled();
      allowDeletion.resolve();
      await secondDispatched.promise;
      await vi.waitFor(() =>
        expect(hoisted.startQueuedSubagentRunMock).toHaveBeenCalledWith(second.runId, "gateway-2"),
      );
      expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledWith(
        first.runId,
        expect.any(String),
      );
    } finally {
      publicationPending = false;
      publication.resolve();
      allowDeletion.resolve();
      await closeSwarmScheduler();
    }
  });

  it("holds the collector slot while an indeterminate launch session is deleted", async () => {
    configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxConcurrent: 1 } },
    });
    let agentCalls = 0;
    let releaseDelete: (() => void) | undefined;
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "agent") {
          const message = String(requireRecord(request.params).message);
          if (
            !message.includes("indeterminate-first") &&
            !message.includes("indeterminate-second")
          ) {
            return { runId: "unrelated" };
          }
          agentCalls += 1;
          if (agentCalls === 1) {
            throw new Error("launch response lost");
          }
          return { runId: "gateway-second" };
        }
        if (request.method === "sessions.delete") {
          return await new Promise<Record<string, unknown>>((resolve) => {
            releaseDelete = () => resolve({});
          });
        }
        return {};
      },
    );

    await spawn(
      { task: "indeterminate-first", collect: true, groupId: "indeterminate" },
      collectorContext,
    );
    await spawn(
      { task: "indeterminate-second", collect: true, groupId: "indeterminate" },
      collectorContext,
    );

    await vi.waitFor(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(agentCalls).toBe(1);
    expect(hoisted.settleFailedQueuedSubagentLaunchMock).not.toHaveBeenCalled();
    releaseDelete?.();
    await vi.waitFor(() => expect(agentCalls).toBe(2));
    expect(hoisted.settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledOnce();
  });

  it("keeps failed-launch cleanup pending when context rollback fails", async () => {
    configOverride = createConfigOverride({ tools: { swarm: true } });
    hoisted.resolveContextEngineMock.mockResolvedValue({
      prepareSubagentSpawn: async () => ({
        rollback: async () => {
          throw new Error("rollback unavailable");
        },
      }),
    });
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        throw new Error("launch failed");
      }
      return {};
    });

    await spawn({ task: "fail launch", collect: true }, collectorContext);

    await vi.waitFor(() =>
      expect(
        hoisted.callGatewayMock.mock.calls.some(
          ([request]) => (request as { method?: string }).method === "sessions.delete",
        ),
      ).toBe(true),
    );
    expect(hoisted.completeCollectorLaunchCleanupMock).not.toHaveBeenCalled();
  });

  it("uses and validates tools.swarm.defaultAgentId for collector children", async () => {
    configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, defaultAgentId: "worker" } },
      agents: {
        defaults: { workspace: os.tmpdir() },
        entries: {
          main: { workspace: "/tmp/workspace-main", subagents: { allowAgents: ["worker"] } },
          worker: { workspace: "/tmp/workspace-worker" },
        },
      },
    });

    const result = await spawn({ task: "collect as worker", collect: true }, collectorContext);

    expect(result.status).toBe("accepted");
    expect(result.childSessionKey).toMatch(/^agent:worker:subagent:/);

    configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, defaultAgentId: "missing" } },
    });
    const rejected = await spawn({ task: "collect as missing", collect: true }, collectorContext);
    expect(rejected.status).toBe("forbidden");
    expect(rejected.error).toContain("tools.swarm.defaultAgentId");
  });

  it("rejects collector live and lifetime caps with config-key errors", async () => {
    configOverride = createConfigOverride({
      tools: {
        swarm: {
          enabled: true,
          maxChildrenPerGroup: 1,
          maxTotalPerGroup: 2,
        },
      },
    });
    hoisted.listSwarmRunsForGroupMock.mockReturnValueOnce([
      { runId: "live", collect: true, groupId: "group" },
    ]);
    const liveRejected = await spawn(
      { task: "second live child", collect: true, groupId: "group" },
      collectorContext,
    );
    expect(liveRejected.status).toBe("forbidden");
    expect(liveRejected.error).toContain("tools.swarm.maxChildrenPerGroup");
    expect(hoisted.listSwarmRunsForGroupMock).toHaveBeenLastCalledWith(
      "group",
      "agent:main:main",
      "main",
    );

    hoisted.listSwarmRunsForGroupMock.mockReturnValueOnce([
      { runId: "done", collect: true, collectorCompletion: { status: "done" } },
      { runId: "failed", collect: true, collectorCompletion: { status: "failed" } },
    ]);
    const totalRejected = await spawn(
      { task: "third lifetime child", collect: true, groupId: "group" },
      collectorContext,
    );
    expect(totalRejected.status).toBe("forbidden");
    expect(totalRejected.error).toContain("tools.swarm.maxTotalPerGroup");
  });

  it("enforces group caps atomically across concurrent collector registration", async () => {
    configOverride = createConfigOverride({
      tools: { swarm: { enabled: true, maxChildrenPerGroup: 1 } },
    });
    hoisted.listSwarmRunsForGroupMock.mockImplementation(() =>
      hoisted.registerSubagentRunMock.mock.calls.map(([run]) => requireRecord(run)),
    );

    const results = await Promise.all([
      spawn({ task: "first concurrent child", collect: true, groupId: "shared" }, collectorContext),
      spawn(
        { task: "second concurrent child", collect: true, groupId: "shared" },
        collectorContext,
      ),
    ]);

    expect(results.map((result) => result.status).toSorted()).toEqual(["accepted", "forbidden"]);
    expect(results.find((result) => result.status === "forbidden")?.error).toContain(
      "tools.swarm.maxChildrenPerGroup",
    );
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("reconciles a transport-ambiguous dispatch so an accepted run is surfaced instead of misreported as an error", async () => {
    let dispatchAttempts = 0;
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; timeoutMs?: number }) => {
        if (request.method === "agent") {
          dispatchAttempts += 1;
          if (dispatchAttempts === 1) {
            throw new Error("gateway timeout after 60000ms");
          }
          if (dispatchAttempts === 2) {
            return {
              runId: "accepted-ambig-run",
              status: "in_flight",
              admissionPending: true,
            };
          }
          return { runId: "accepted-ambig-run", status: "in_flight" };
        }
        return request.method?.startsWith("sessions.") ? { ok: true } : {};
      },
    );
    const context = { agentSessionKey: "agent:main:main" };

    const result = await spawn({ task: "ambiguous child" }, context);

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
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  });

  it("does not register a child when reconciliation finds a terminal run", async () => {
    let dispatchAttempts = 0;
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent" && ++dispatchAttempts === 1) {
        throw new Error("gateway timeout after 60000ms");
      }
      return request.method === "agent"
        ? { runId: "stopped-run", status: "timeout" }
        : { ok: true };
    });

    const result = await spawn({ task: "ambiguous terminal child" });

    expect(dispatchAttempts).toBe(2);
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("no active subagent run (status: timeout)"),
    });
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("shares pending child capacity between native and visible spawn paths", async ({ signal }) => {
    configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          subagents: { maxChildrenPerAgent: 1 },
        },
        entries: { main: { workspace: "/tmp/workspace-main" } },
      },
    });
    await expectSharedPendingSpawnCapacity({
      config: configOverride as OpenClawConfig,
      spawn,
      callGatewayMock: hoisted.callGatewayMock,
      countActiveRuns: hoisted.countActiveRunsForSessionMock,
      signal,
    });
  });

  it("rejects invalid collector output schemas before creating a child session", async () => {
    configOverride = createConfigOverride({ tools: { swarm: true } });

    const rejected = await spawn(
      {
        task: "invalid schema",
        collect: true,
        outputSchema: { type: "object", properties: "invalid" },
      },
      collectorContext,
    );

    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("Invalid sessions_spawn outputSchema");
    expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("rejects schema collection for a model that cannot call tools", async () => {
    configOverride = createConfigOverride({ tools: { swarm: true } });
    hoisted.prepareModelChoiceMock.mockImplementation(async (request) => {
      const choice = await supportedSpawnModelChoice(request);
      if (choice.kind !== "resolved") {
        throw new Error("Expected supported fixture model");
      }
      return { ...choice, model: { ...choice.model, compat: { supportsTools: false } } };
    });

    const rejected = await spawn(
      {
        task: "structured result",
        model: "openai/no-tools",
        collect: true,
        outputSchema: { type: "object" },
      },
      collectorContext,
    );

    expect(rejected.status).toBe("error");
    expect(rejected.error).toContain("requires a tool-capable target model");
    expect(hoisted.prepareModelChoiceMock).toHaveBeenCalledOnce();
    expect(hoisted.updateSessionStoreMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it.each(["off", "all"] as const)(
    "uses the global requester sandbox mode %s for cross-agent spawns",
    async (sandboxMode) => {
      let persistedStore: Record<string, Record<string, unknown>> | undefined;
      installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
        onStore: (store) => {
          persistedStore = store;
        },
      });
      configOverride = createConfigOverride({
        session: {
          scope: "global",
        },
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: os.tmpdir(),
          },
          entries: {
            main: {
              sandbox: { mode: sandboxMode },
              workspace: "/tmp/workspace-main",
              subagents: {
                allowAgents: ["worker"],
              },
            },
            worker: { workspace: "/tmp/workspace-worker" },
          },
        },
      });

      hoisted.resolveSandboxRuntimeStatusMock.mockImplementation(resolveSandboxRuntimeStatus);

      const result = await spawn(
        {
          task: "attribute worker run",
          agentId: "worker",
        },
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
      expect(persistedStore?.[result.childSessionKey as string]).toMatchObject({
        permissionMode: "guarded",
        sessionRoot: resolveUserPath("/tmp/workspace-worker"),
      });
      const registerInput = firstRegisteredSubagentRun();
      expect(registerInput.childSessionKey).toBe(result.childSessionKey);
      expect(registerInput.agentId).toBe("worker");
      expect(registerInput.requesterSessionKey).toBe("global");
      expect(registerInput.requesterAgentId).toBe("main");
    },
  );

  it.each([
    { required: false, source: "profile", sandbox: "inherit" },
    { required: true, source: "profile", sandbox: "require" },
  ] as const)(
    "inherits native child $source provenance from a required parent ($required) with sandbox=$sandbox",
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
        let persistedStore: Record<string, Record<string, unknown>> | undefined;
        installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
          onStore: (store) => {
            persistedStore = store;
          },
        });

        const result = await spawn(
          { task: "continue under the parent's isolation policy", sandbox },
          { agentSessionKey: parentSessionKey },
        );

        expect(result.status).toBe("accepted");
        const entry = persistedStore?.[result.childSessionKey as string];
        expect(entry).toMatchObject({
          createdVia: "spawn",
          createdActor: required ? actor : { type: "agent", id: "main" },
          parentSessionKey,
        });
        expect(entry?.sandbox).toBe(required ? "required" : undefined);
      });
    },
  );

  it("rejects a split-key sandboxed requester spawning an unsandboxed native child via the explicit sandboxed flag", async () => {
    // The durable lineage key is unsandboxed; the active caller classification must win (#137779).
    const result = await spawn(
      { task: "try an unsandboxed child from a split-key sandboxed parent" },
      {
        agentSessionKey: "agent:main:main",
        sandboxed: true,
      },
    );
    expect(result).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("cannot spawn unsandboxed"),
    });
    expectNoChildSpawnSideEffects();
  });

  it("authorizes explicit model overrides for in-process child launches", async () => {
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.callGatewayMock.mockRejectedValue(new Error("unexpected websocket gateway call"));
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      return method === "agent" ? { runId: "run-in-process-model" } : { ok: true };
    });

    const result = await spawn({ task: "spawn on the requested model", model: "openai/gpt-5.4" });

    expect(result).toMatchObject({ status: "accepted", runId: "run-in-process-model" });
    const agentDispatch = hoisted.dispatchGatewayMethodInProcessMock.mock.calls.find(
      ([method]) => method === "agent",
    );
    expect(agentDispatch?.[1]).toMatchObject({ provider: "openai", model: "gpt-5.4" });
    expect(agentDispatch?.[2]).toMatchObject({
      allowSyntheticModelOverride: true,
      forceSyntheticClient: true,
    });
  });

  it("keeps admin-scoped cleanup on in-process spawn failure", async () => {
    hoisted.hasInProcessGatewayContextMock.mockReturnValue(true);
    hoisted.callGatewayMock.mockRejectedValue(new Error("unexpected websocket gateway call"));
    hoisted.dispatchGatewayMethodInProcessMock.mockImplementation(async (method: string) => {
      if (method === "agent") {
        throw new Error("spawn failed");
      }
      return { ok: true };
    });

    const result = await spawn({
      task: "spawn failure cleanup",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("spawn failed");
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.dispatchGatewayMethodInProcessMock).toHaveBeenCalledWith(
      "sessions.delete",
      expect.objectContaining({
        key: result.childSessionKey,
        deleteTranscript: true,
      }),
      expect.objectContaining({
        forceSyntheticClient: true,
        syntheticScopes: ["operator.admin"],
        timeoutMs: 60_000,
      }),
    );
  });

  it.each(
    inheritedSpawnCases.preferences.filter(
      ({ requesterThinkingLevel, requesterAgent }) =>
        requesterThinkingLevel === "ultra" && !requesterAgent,
    ),
  )(
    "$name",
    async ({ task, requesterState, requesterThinkingLevel, thinkingOverride, expected }) => {
      hoisted.loadSessionStoreMock.mockReturnValue({ "agent:main:main": requesterState });
      const readStore = captureStore();
      const result = await spawn({ task, thinking: thinkingOverride }, { requesterThinkingLevel });
      expect(result.status).toBe("accepted");
      expect(readStore()[result.childSessionKey!]?.thinkingLevel).toBe(expected);
      expect(requireRecord(gatewayRequest("agent").params).thinking).toBe(thinkingOverride);
    },
  );

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

  it("uses requester agent thinkingDefault after a failed preference read", async () => {
    // Import after the spawn helper installs the mocked session runtime.
    const { readRequesterPreferences } = await import("./subagent-spawn-requester-prefs.js");
    hoisted.loadSessionStoreMock.mockImplementation(() => {
      throw new Error("preference read unavailable");
    });

    const preferences = await readRequesterPreferences({
      cfg: { agents: { entries: { main: { thinkingDefault: "high" } } } },
      requesterInternalKey: "agent:main:main",
      requesterAgentId: "main",
    });
    expect(preferences.thinkingLevel).toBe("high");
  });

  it("inherits requester selected-model thinking without a session or agent default", async () => {
    configOverride = createConfigOverride({
      agents: {
        defaults: {
          workspace: os.tmpdir(),
          models: { "openai-codex/gpt-5.4": { params: { thinking: "low" } } },
        },
        entries: { main: { workspace: "/tmp/workspace-main" } },
      },
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:main:main": {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "anthropic",
        model: "claude-opus-4-7",
      },
    });
    const readStore = captureStore();
    const result = await spawn(
      { task: "inherit requester thinking" },
      { agentSessionKey: "agent:main:main" },
    );
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
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledOnce();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.callGatewayMock).not.toHaveBeenCalled();
    expect(hoisted.emitSessionLifecycleEventMock).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
