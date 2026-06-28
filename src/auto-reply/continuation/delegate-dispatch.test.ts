import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock TaskFlow registry — delegate-store resolves it transitively.
const mockFlows = new Map<string, Record<string, unknown>>();
const enqueueSystemEventMock = vi.fn();
const loggerRecords: Array<{ level: string; message: string }> = [];
const spawnSubagentDirectMock = vi.fn();
let flowIdCounter = 0;
let listTaskFlowsShouldThrow = false;
const activeRegistryChildSessionKeys = new Set<string>();
const staleRegistryChildSessionKeys = new Set<string>();
const acceptedChildSessionKeys = new Set<string>();

vi.mock("../../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
  getSubagentRunByChildSessionKey: (childSessionKey: string) =>
    activeRegistryChildSessionKeys.has(childSessionKey)
      ? { runId: "run-active", childSessionKey }
      : staleRegistryChildSessionKeys.has(childSessionKey)
        ? { runId: "run-stale", childSessionKey }
        : null,
  hasLiveContinuationDelegateChildRun: (params: { childSessionKey: string }) =>
    acceptedChildSessionKeys.has(params.childSessionKey),
  isSubagentRunLive: (entry: { runId?: string } | null | undefined) =>
    entry?.runId === "run-active",
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, options: unknown) => enqueueSystemEventMock(text, options),
}));

vi.mock("../../logging/subsystem.js", () => {
  const record =
    (level: string) =>
    (message: string): void => {
      loggerRecords.push({ level, message });
    };
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    raw: record("raw"),
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
  };
});

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn((params: Record<string, unknown>) => {
    const flowId = `flow-${++flowIdCounter}`;
    mockFlows.set(flowId, {
      flowId,
      syncMode: "managed",
      ownerKey: params.ownerKey,
      controllerId: params.controllerId,
      status: "queued",
      stateJson: params.stateJson,
      goal: params.goal,
      currentStep: params.currentStep,
      revision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return mockFlows.get(flowId);
  }),
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) => {
    if (listTaskFlowsShouldThrow) {
      throw new Error("taskflow unavailable");
    }
    return [...mockFlows.values()].filter((f) => f.ownerKey === ownerKey);
  }),
  listTaskFlowRecords: vi.fn(() => [...mockFlows.values()]),
  getTaskFlowById: vi.fn((flowId: string) => mockFlows.get(flowId)),
  updateFlowRecordByIdExpectedRevision: vi.fn(
    (params: { flowId: string; expectedRevision: number; patch: Record<string, unknown> }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      Object.assign(flow, params.patch);
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  finishFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      flow.status = "succeeded";
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  failFlow: vi.fn((params: { flowId: string }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  noopTracer,
  resetContinuationTracer,
  setContinuationTracer,
} from "../../infra/continuation-tracer.js";
import {
  dispatchToolDelegates,
  recoverPendingContinuationDelegates,
  resetDelegateDispatchHedgesForTests,
} from "./delegate-dispatch.js";
import { cancelPendingDelegates, enqueuePendingDelegate } from "./delegate-store.js";
import { hasLiveContinuationTimerRefs, resetContinuationStateForTests } from "./state.js";

beforeEach(() => {
  mockFlows.clear();
  enqueueSystemEventMock.mockClear();
  loggerRecords.length = 0;
  spawnSubagentDirectMock.mockReset().mockResolvedValue({ status: "accepted" });
  flowIdCounter = 0;
  listTaskFlowsShouldThrow = false;
  activeRegistryChildSessionKeys.clear();
  staleRegistryChildSessionKeys.clear();
  acceptedChildSessionKeys.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  resetDelegateDispatchHedgesForTests();
  resetContinuationStateForTests();
  resetContinuationTracer();
  clearRuntimeConfigSnapshot();
  mockFlows.clear();
  listTaskFlowsShouldThrow = false;
  activeRegistryChildSessionKeys.clear();
  staleRegistryChildSessionKeys.clear();
  acceptedChildSessionKeys.clear();
  vi.useRealTimers();
});

describe("hedge timer ref/handle cleanup", () => {
  it("releases the timer ref + handle after a natural hedge fire", async () => {
    const sessionKey = "session-hedge-natural";

    // Queue an unmatured delegate so `dispatchToolDelegates` arms a hedge.
    enqueuePendingDelegate(sessionKey, { task: "deferred work", delayMs: 30_000 });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    // Cancel the delegate before the hedge fires so the re-dispatch hits
    // the empty-queue / no-unmatured path — isolates the natural-fire
    // cleanup we're asserting.
    cancelPendingDelegates(sessionKey);

    await vi.advanceTimersByTimeAsync(30_000 + 100);
    // Drain the fire-and-forget re-dispatch promise.
    await vi.runAllTimersAsync();

    // The natural-fire branch must mirror clearHedgeTimer cleanup: delete the
    // hedgeTimers entry and unregister the continuation timer handle so the ref
    // count returns to zero.
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
  });

  it("releases the timer ref + handle on explicit clearHedgeTimer", async () => {
    const sessionKey = "session-hedge-cancel";

    enqueuePendingDelegate(sessionKey, { task: "deferred", delayMs: 30_000 });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    // Cancel then re-dispatch: the follow-up call sees no unmatured
    // delegate and takes the clearHedgeTimer branch, which should drop
    // the ref to zero.
    cancelPendingDelegates(sessionKey);
    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(false);
  });

  it("surfaces hedge dispatch failures and re-arms a retry instead of orphaning queued delegates", async () => {
    const sessionKey = "session-hedge-failure";

    enqueuePendingDelegate(sessionKey, { task: "deferred work", delayMs: 30_000 });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);

    listTaskFlowsShouldThrow = true;
    await vi.advanceTimersByTimeAsync(30_000 + 100);
    await Promise.resolve();

    expect(loggerRecords).toContainEqual({
      level: "error",
      message: `[continuation:delegate-hedge-error] error=taskflow unavailable session=${sessionKey}`,
    });
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("Hedge-timer dispatch failed; queued delegates may be orphaned."),
      { sessionKey, trusted: true },
    );
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);
    expect(hasLiveContinuationTimerRefs(sessionKey)).toBe(true);
  });
  it("does not carry current-turn reserved delegate slots into hedge-fired dispatch", async () => {
    const sessionKey = "session-hedge-reserved-slot";
    enqueuePendingDelegate(sessionKey, { task: "deferred work", delayMs: 30_000 });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
      config: {
        enabled: true,
        defaultDelayMs: 15_000,
        minDelayMs: 5_000,
        maxDelayMs: 300_000,
        maxChainLength: 10,
        costCapTokens: 500_000,
        maxDelegatesPerTurn: 1,
        maxPendingWork: 32,
        crossSessionTargeting: "disabled",
      },
      reservedDelegateSlots: 1,
    });

    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).not.toHaveBeenCalledWith(
      expect.stringContaining("maxDelegatesPerTurn exceeded"),
      expect.anything(),
    );
  });

  it("persists advanced chain state after hedge-fired dispatch when a callback is provided", async () => {
    const sessionKey = "session-hedge-persist-chain";
    const persistChainState = vi.fn();
    enqueuePendingDelegate(sessionKey, { task: "deferred persisted work", delayMs: 30_000 });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: 123, accumulatedChainTokens: 456 },
      ctx: { sessionKey },
      maxChainLength: 10,
      loadFreshChainState: () => ({
        currentChainCount: 0,
        chainStartedAt: 123,
        accumulatedChainTokens: 456,
      }),
      persistChainState,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(persistChainState).toHaveBeenCalledWith(
      expect.objectContaining({
        currentChainCount: 1,
        chainStartedAt: 123,
        accumulatedChainTokens: 456,
      }),
    );
  });
});

describe("tool delegate dispatch contract", () => {
  it("recovers a running delegate by reconciling the deterministic live child", async () => {
    const sessionKey = "agent:main:root";
    enqueuePendingDelegate(sessionKey, { task: "recover already spawned child" });
    const flowId = [...mockFlows.keys()][0];
    const digest = crypto.createHash("sha256").update(flowId).digest("hex").slice(0, 32);
    activeRegistryChildSessionKeys.add(`agent:main:subagent:continuation-${digest}`);

    const first = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
      recoverRunningDelegates: true,
    });

    expect(first.dispatched).toBe(1);
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(mockFlows.get(flowId)?.status).toBe("succeeded");
    expect(mockFlows.get(flowId)?.stateJson).toMatchObject({
      childSessionKey: `agent:main:subagent:continuation-${digest}`,
    });
  });

  it("derives deterministic child session keys from canonical agent session parsing", async () => {
    const sessionKey = "AGENT:Work:root";
    enqueuePendingDelegate(sessionKey, { task: "mixed-case parent key" });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    const expectedChildSessionKey =
      "agent:work:subagent:continuation-" +
      crypto.createHash("sha256").update("flow-1").digest("hex").slice(0, 32);
    expect(mockFlows.get("flow-1")?.stateJson).toMatchObject({
      childSessionKey: expectedChildSessionKey,
    });
  });

  it("caps dispatch at maxDelegatesPerTurn and surfaces over-limit delegates", async () => {
    const sessionKey = "session-delegate-cap";
    for (let index = 0; index < 6; index++) {
      enqueuePendingDelegate(sessionKey, { task: `delegate-${index}` });
    }

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.dispatched).toBe(5);
    expect(result.rejected).toBe(1);
    expect(result.chainState.currentChainCount).toBe(5);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(5);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("maxDelegatesPerTurn exceeded (5). Task: delegate-5"),
      { sessionKey, trusted: true },
    );
  });

  it("honors resolved run config and delegate slots already consumed this turn", async () => {
    const sessionKey = "session-delegate-cap-reserved";
    for (let index = 0; index < 3; index++) {
      enqueuePendingDelegate(sessionKey, { task: `delegate-${index}` });
    }

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
      config: {
        enabled: true,
        defaultDelayMs: 15_000,
        minDelayMs: 5_000,
        maxDelayMs: 300_000,
        maxChainLength: 10,
        costCapTokens: 500_000,
        maxDelegatesPerTurn: 2,
        maxPendingWork: 32,
        crossSessionTargeting: "disabled",
        earlyWarningBand: 0.3125,
      },
      reservedDelegateSlots: 1,
    });

    expect(result.dispatched).toBe(1);
    expect(result.rejected).toBe(2);
    expect(result.chainState.currentChainCount).toBe(1);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("maxDelegatesPerTurn exceeded (2). Task: delegate-1"),
      { sessionKey, trusted: true },
    );
  });

  it("maps delegate modes into spawn flags without changing normal delegates", async () => {
    const sessionKey = "session-delegate-modes";
    enqueuePendingDelegate(sessionKey, { task: "normal" });
    enqueuePendingDelegate(sessionKey, { task: "silent", mode: "silent" });
    enqueuePendingDelegate(sessionKey, { task: "wake", mode: "silent-wake" });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    const spawnParams = spawnSubagentDirectMock.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    expect(spawnParams[0]).toMatchObject({
      task: expect.stringContaining("normal"),
      drainsContinuationDelegateQueue: true,
    });
    expect(spawnParams[0]).not.toHaveProperty("silentAnnounce");
    expect(spawnParams[0]).not.toHaveProperty("wakeOnReturn");
    expect(spawnParams[1]).toMatchObject({
      task: expect.stringContaining("silent"),
      silentAnnounce: true,
      drainsContinuationDelegateQueue: true,
    });
    expect(spawnParams[1]).not.toHaveProperty("wakeOnReturn");
    expect(spawnParams[2]).toMatchObject({
      task: expect.stringContaining("wake"),
      silentAnnounce: true,
      wakeOnReturn: true,
      drainsContinuationDelegateQueue: true,
    });
  });

  it("dispatches silent and silent-wake default returns without target fields", async () => {
    const sessionKey = "session-delegate-default-return-modes";
    enqueuePendingDelegate(sessionKey, { task: "silent default", mode: "silent" });
    enqueuePendingDelegate(sessionKey, { task: "wake default", mode: "silent-wake" });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result).toMatchObject({ dispatched: 2, rejected: 0 });
    const spawnParams = spawnSubagentDirectMock.mock.calls.map(
      (call) => call[0] as Record<string, unknown>,
    );
    expect(spawnParams[0]).toMatchObject({
      task: expect.stringContaining("silent default"),
      silentAnnounce: true,
    });
    expect(spawnParams[0]).not.toHaveProperty("continuationTargetSessionKey");
    expect(spawnParams[0]).not.toHaveProperty("continuationTargetSessionKeys");
    expect(spawnParams[0]).not.toHaveProperty("continuationFanoutMode");
    expect(spawnParams[1]).toMatchObject({
      task: expect.stringContaining("wake default"),
      silentAnnounce: true,
      wakeOnReturn: true,
    });
    expect(spawnParams[1]).not.toHaveProperty("continuationTargetSessionKey");
    expect(spawnParams[1]).not.toHaveProperty("continuationTargetSessionKeys");
    expect(spawnParams[1]).not.toHaveProperty("continuationFanoutMode");
  });

  it("threads cross-session targeting metadata into spawned continuation runs", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const sessionKey = "session-delegate-targeting";
    enqueuePendingDelegate(sessionKey, {
      task: "targeted fanout",
      mode: "silent-wake",
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("targeted fanout"),
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationTargetSessionKeys: ["agent:main:root", "agent:main:sibling"],
      }),
      expect.objectContaining({
        agentSessionKey: sessionKey,
      }),
    );
  });

  it("threads persisted traceparent into spawned continuation runs", async () => {
    const sessionKey = "session-delegate-traceparent";
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    enqueuePendingDelegate(sessionKey, {
      task: "continue traced work",
      traceparent,
    });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("continue traced work"),
        traceparent,
      }),
      expect.objectContaining({
        agentSessionKey: sessionKey,
      }),
    );
  });

  it("threads the persisted model override into spawned continuation runs", async () => {
    const sessionKey = "session-delegate-model";
    enqueuePendingDelegate(sessionKey, {
      task: "continue on a specific model",
      model: "github-copilot/gpt-5.4-nano",
    });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("continue on a specific model"),
        model: "github-copilot/gpt-5.4-nano",
      }),
      expect.objectContaining({
        agentSessionKey: sessionKey,
      }),
    );
  });

  it("omits model from spawned continuation runs when the delegate inherits the parent model", async () => {
    const sessionKey = "session-delegate-inherited-model";
    enqueuePendingDelegate(sessionKey, { task: "continue with inherited model" });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    const spawnParams = spawnSubagentDirectMock.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnParams.task).toEqual(expect.stringContaining("continue with inherited model"));
    expect(spawnParams).not.toHaveProperty("model");
  });

  it("resolves persisted logical traceparents before spawning continuation runs", async () => {
    const sessionKey = "session-delegate-exported-traceparent";
    const logicalTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const exportedTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    setContinuationTracer({
      startSpan: () => noopTracer.startSpan("x"),
      formatTraceparent: (traceContext) =>
        traceContext.traceId === "4bf92f3577b34da6a3ce929d0e0e4736"
          ? exportedTraceparent
          : undefined,
    });
    enqueuePendingDelegate(sessionKey, {
      task: "continue traced work",
      traceparent: logicalTraceparent,
    });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("continue traced work"),
        traceparent: exportedTraceparent,
      }),
      expect.objectContaining({
        agentSessionKey: sessionKey,
      }),
    );
  });

  it("carries the exported dispatch span traceparent into spawned continuation runs", async () => {
    const sessionKey = "session-delegate-dispatch-carrier";
    const persistedTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const dispatchTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    const dispatchSpan = {
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      traceparent: vi.fn(() => dispatchTraceparent),
      end: vi.fn(),
    };
    const startSpan = vi.fn(() => dispatchSpan);
    setContinuationTracer({
      startSpan,
      formatTraceparent: () => undefined,
    });
    enqueuePendingDelegate(sessionKey, {
      task: "continue traced work from dispatch",
      traceparent: persistedTraceparent,
    });

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(startSpan).toHaveBeenCalledWith(
      "continuation.delegate.dispatch",
      expect.objectContaining({
        traceparent: persistedTraceparent,
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("continue traced work from dispatch"),
        traceparent: dispatchTraceparent,
      }),
      expect.objectContaining({
        agentSessionKey: sessionKey,
      }),
    );
    expect(dispatchSpan.setStatus).toHaveBeenCalledWith("OK");
    expect(dispatchSpan.end).toHaveBeenCalledTimes(1);
  });

  it("advances chain state and prefixes spawned tasks with the next hop", async () => {
    const sessionKey = "session-delegate-chain";
    enqueuePendingDelegate(sessionKey, { task: "inspect logs" });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 2,
        chainStartedAt: 1_700_000_000_000,
        accumulatedChainTokens: 123,
      },
      ctx: { sessionKey, agentChannel: "discord", agentTo: "channel" },
      maxChainLength: 10,
    });

    expect(result.chainState).toEqual({
      currentChainCount: 3,
      chainStartedAt: 1_700_000_000_000,
      accumulatedChainTokens: 123,
      chainId: expect.any(String),
    });
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "[continuation:chain-hop:3] Delegated task (turn 3/10): inspect logs",
      }),
      {
        agentSessionKey: sessionKey,
        agentChannel: "discord",
        agentAccountId: undefined,
        agentTo: "channel",
        agentThreadId: undefined,
      },
    );
  });

  it("marks rejected/thrown delegates failed without aborting later delegates", async () => {
    const sessionKey = "session-delegate-spawn-failure";
    enqueuePendingDelegate(sessionKey, { task: "rejected" });
    enqueuePendingDelegate(sessionKey, { task: "throws" });
    enqueuePendingDelegate(sessionKey, { task: "accepted" });
    spawnSubagentDirectMock
      .mockResolvedValueOnce({ status: "forbidden" })
      .mockRejectedValueOnce(new Error("spawn unavailable"))
      .mockResolvedValueOnce({ status: "accepted" });

    const queuedBefore = [...mockFlows.values()]
      .filter((f) => f.ownerKey === sessionKey && f.status === "queued")
      .map((f) => f.flowId as string);

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.dispatched).toBe(1);
    expect(result.rejected).toBe(2);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(3);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("DELEGATE spawn forbidden"),
      { sessionKey, trusted: true },
    );
    expect(enqueueSystemEventMock).toHaveBeenCalledWith(
      expect.stringContaining("DELEGATE spawn failed: spawn unavailable"),
      { sessionKey, trusted: true },
    );
    expect(mockFlows.get(queuedBefore[0])?.status).toBe("failed");
    expect(mockFlows.get(queuedBefore[1])?.status).toBe("failed");
    expect(mockFlows.get(queuedBefore[2])?.status).toBe("succeeded");
  });

  it("marks over-limit delegates failed instead of leaving them as silent success", async () => {
    const sessionKey = "session-delegate-over-limit-status";
    for (let index = 0; index < 6; index++) {
      enqueuePendingDelegate(sessionKey, { task: `delegate-${index}` });
    }

    const queuedBefore = [...mockFlows.values()]
      .filter((f) => f.ownerKey === sessionKey && f.status === "queued")
      .map((f) => f.flowId as string);

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(mockFlows.get(queuedBefore[5])?.status).toBe("failed");
  });
});

describe("dispatchToolDelegates — TaskFlow status after spawn failure", () => {
  // Pins the contract that the regression report called out as structurally unpinned:
  // "what is the intended TaskFlow status after spawn failure?"
  //
  // Current behavior in dispatchToolDelegates:
  //   1. consumePendingDelegates(sessionKey) calls finishFlow on
  //      each consumed delegate → TaskFlow row → status="succeeded"
  //   2. spawnSubagentDirect(...) per delegate
  //   3. If spawn returns non-"accepted" status → log info + enqueue system
  //      event + rejected++
  //   4. If spawn throws → log info + enqueue system event + rejected++
  //   5. NO retry, NO un-finish, NO mark-for-inspection — durable record is
  //      already in succeeded state, only observability remains.
  //
  // This is the **one-shot-loss + observability-only** invariant. It is
  // substrate-consistent with task-executor's exit-code-failure shape (also
  // single-shot, no retry). The substrate has NO infrastructure for automatic
  // re-enqueue, NO retry-count metadata field, NO transitional
  // failed_retryable state — runaway-amplification-via-retry-storm is
  // structurally pre-empted by the absence of those primitives.
  //
  // Pin the contract here so a refactor that introduces retry semantics
  // OR moves finishFlow to after-spawn-success will surface as a test
  // failure rather than a silent invariant change. The deliberate choice
  // is one-shot / no-retry semantics that do not silently present spawn
  // failure as success.

  it("marks consumed flows failed after spawn rejection", async () => {
    const sessionKey = "session-449-rejected";
    enqueuePendingDelegate(sessionKey, { task: "rejected-task" });
    spawnSubagentDirectMock.mockResolvedValueOnce({ status: "forbidden" });

    // Capture flowId before dispatch so we can inspect its post-dispatch state.
    const queuedBefore = [...mockFlows.values()].filter(
      (f) => f.ownerKey === sessionKey && f.status === "queued",
    );
    expect(queuedBefore).toHaveLength(1);
    const flowId = queuedBefore[0].flowId as string;

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.dispatched).toBe(0);
    expect(result.rejected).toBe(1);

    // Honest failure visibility on the same one-shot substrate.
    const finalized = mockFlows.get(flowId);
    expect(finalized?.status).toBe("failed");
  });

  it("marks consumed flows failed after spawn throws", async () => {
    const sessionKey = "session-449-thrown";
    enqueuePendingDelegate(sessionKey, { task: "throwing-task" });
    spawnSubagentDirectMock.mockRejectedValueOnce(new Error("spawn unavailable"));

    const queuedBefore = [...mockFlows.values()].filter(
      (f) => f.ownerKey === sessionKey && f.status === "queued",
    );
    expect(queuedBefore).toHaveLength(1);
    const flowId = queuedBefore[0].flowId as string;

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.dispatched).toBe(0);
    expect(result.rejected).toBe(1);

    // Same shape for the throw-path: no retry, but durable failed-state.
    const finalized = mockFlows.get(flowId);
    expect(finalized?.status).toBe("failed");
  });

  it("preserves per-delegate terminal truth across mixed spawn outcomes (rejected + thrown + accepted)", async () => {
    const sessionKey = "session-449-mixed";
    enqueuePendingDelegate(sessionKey, { task: "rejected" });
    enqueuePendingDelegate(sessionKey, { task: "throws" });
    enqueuePendingDelegate(sessionKey, { task: "accepted" });
    spawnSubagentDirectMock
      .mockResolvedValueOnce({ status: "forbidden" })
      .mockRejectedValueOnce(new Error("spawn unavailable"))
      .mockResolvedValueOnce({ status: "accepted" });

    const queuedBefore = [...mockFlows.values()]
      .filter((f) => f.ownerKey === sessionKey && f.status === "queued")
      .map((f) => f.flowId as string);
    expect(queuedBefore).toHaveLength(3);

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(mockFlows.get(queuedBefore[0])?.status).toBe("failed");
    expect(mockFlows.get(queuedBefore[1])?.status).toBe("failed");
    expect(mockFlows.get(queuedBefore[2])?.status).toBe("succeeded");
  });
});

describe("dispatchToolDelegates — nonexistent target session", () => {
  it("passes a nonexistent targetSessionKey through to spawn without throwing", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const sessionKey = "session-nonexistent-target";
    enqueuePendingDelegate(sessionKey, {
      task: "deliver to ghost",
      mode: "silent-wake",
      targetSessionKey: "agent:main:never-existed",
    });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.dispatched).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.chainState.currentChainCount).toBe(1);
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("deliver to ghost"),
        silentAnnounce: true,
        wakeOnReturn: true,
        continuationTargetSessionKey: "agent:main:never-existed",
      }),
      expect.objectContaining({ agentSessionKey: sessionKey }),
    );
  });

  it("passes nonexistent targetSessionKeys (plural) through to spawn", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const sessionKey = "session-nonexistent-targets-plural";
    enqueuePendingDelegate(sessionKey, {
      task: "deliver to ghosts",
      mode: "silent-wake",
      targetSessionKeys: ["agent:main:ghost", "agent:main:phantom"],
    });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.dispatched).toBe(1);
    expect(result.rejected).toBe(0);
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        continuationTargetSessionKeys: ["agent:main:ghost", "agent:main:phantom"],
      }),
      expect.objectContaining({ agentSessionKey: sessionKey }),
    );
  });

  it("normalizes empty-string targetSessionKey away from spawn params", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const sessionKey = "session-empty-target";
    enqueuePendingDelegate(sessionKey, {
      task: "deliver to empty",
      targetSessionKey: "",
    });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.dispatched).toBe(1);
    expect(result.rejected).toBe(0);
    const spawnParams = spawnSubagentDirectMock.mock.calls[0][0] as Record<string, unknown>;
    expect(spawnParams).not.toHaveProperty("continuationTargetSessionKey");
  });

  it("advances chain state correctly when targeting a nonexistent session", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const sessionKey = "session-nonexistent-chain";
    enqueuePendingDelegate(sessionKey, {
      task: "chained ghost delivery",
      targetSessionKey: "agent:main:stale-removed",
    });

    const result = await dispatchToolDelegates({
      sessionKey,
      chainState: {
        currentChainCount: 3,
        chainStartedAt: 1_700_000_000_000,
        accumulatedChainTokens: 500,
      },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(result.chainState).toEqual({
      currentChainCount: 4,
      chainStartedAt: 1_700_000_000_000,
      accumulatedChainTokens: 500,
      chainId: expect.any(String),
    });
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("[continuation:chain-hop:4]"),
        continuationTargetSessionKey: "agent:main:stale-removed",
      }),
      expect.objectContaining({ agentSessionKey: sessionKey }),
    );
  });

  it("marks the TaskFlow record succeeded for a nonexistent target (same as normal)", async () => {
    setRuntimeConfigSnapshot({
      agents: { defaults: { continuation: { crossSessionTargeting: "enabled" } } },
    });
    const sessionKey = "session-nonexistent-taskflow";
    enqueuePendingDelegate(sessionKey, {
      task: "taskflow ghost",
      targetSessionKey: "agent:main:never-existed",
    });

    const queuedBefore = [...mockFlows.values()].filter(
      (f) => f.ownerKey === sessionKey && f.status === "queued",
    );
    expect(queuedBefore).toHaveLength(1);
    const flowId = queuedBefore[0].flowId as string;

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(mockFlows.get(flowId)?.status).toBe("succeeded");
  });
});

describe("recoverPendingContinuationDelegates", () => {
  beforeEach(() => {
    setRuntimeConfigSnapshot({
      agents: {
        defaults: {
          continuation: {
            enabled: true,
            maxChainLength: 10,
            maxDelegatesPerTurn: 5,
          },
        },
      },
    });
  });

  it("uses the recovered session key even when caller ctx has a stale sessionKey", async () => {
    const sessionKey = "session-recovered-ctx";
    enqueuePendingDelegate(sessionKey, { task: "recover ctx" });

    await recoverPendingContinuationDelegates({
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey: "stale-session" },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentSessionKey: sessionKey }),
    );
  });

  it("respawns when the subagent registry row is stale", async () => {
    const sessionKey = "agent:main:stale-registry-parent";
    enqueuePendingDelegate(sessionKey, { task: "stale registry recovery" });
    const deterministicChildKey =
      "agent:main:subagent:continuation-" +
      crypto.createHash("sha256").update("flow-1").digest("hex").slice(0, 32);
    staleRegistryChildSessionKeys.add(deterministicChildKey);

    await recoverPendingContinuationDelegates({
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(mockFlows.get("flow-1")).toMatchObject({ status: "succeeded" });
  });

  it("replays a claimed delegate after a crash before accept exactly once", async () => {
    const sessionKey = "agent:main:boot-replay-parent";
    enqueuePendingDelegate(sessionKey, { task: "boot replay once" });
    const flow = mockFlows.get("flow-1");
    expect(flow).toBeDefined();
    flow!.status = "running";
    flow!.currentStep = "Released to continuation scheduler";
    flow!.revision = 1;

    await recoverPendingContinuationDelegates({
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      maxChainLength: 10,
    });

    const deterministicChildKey =
      "agent:main:subagent:continuation-" +
      crypto.createHash("sha256").update("flow-1").digest("hex").slice(0, 32);
    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ continuationDelegateFlowId: "flow-1" }),
      expect.objectContaining({ agentSessionKey: sessionKey }),
    );
    expect(mockFlows.get("flow-1")).toMatchObject({
      status: "succeeded",
      stateJson: expect.objectContaining({ childSessionKey: deterministicChildKey }),
    });
  });

  it("reconciles a claimed continuation child accepted before registry registration", async () => {
    const sessionKey = "agent:main:parent";
    enqueuePendingDelegate(sessionKey, { task: "recover without duplicate spawn" });
    const flow = [...mockFlows.values()].find((entry) => entry.ownerKey === sessionKey);
    expect(flow?.flowId).toBe("flow-1");

    await dispatchToolDelegates({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      ctx: { sessionKey },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);

    // Simulate a crash after gateway accept but before registerSubagentRun/finishFlow:
    // TaskFlow remains running at the claimed revision, while the deterministic
    // child session already has a live agent-run context. Recovery must commit
    // acceptance and skip a second spawn.
    const runningFlow = mockFlows.get("flow-1");
    expect(runningFlow?.status).toBe("succeeded");
    runningFlow!.status = "running";
    runningFlow!.endedAt = undefined;
    runningFlow!.revision = 1;
    const deterministicChildKey =
      "agent:main:subagent:continuation-" +
      crypto.createHash("sha256").update("flow-1").digest("hex").slice(0, 32);
    acceptedChildSessionKeys.add(deterministicChildKey);

    await recoverPendingContinuationDelegates({
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    expect(mockFlows.get("flow-1")).toMatchObject({
      status: "succeeded",
      stateJson: expect.objectContaining({ childSessionKey: deterministicChildKey }),
    });
  });

  it("does not replay running delegates claimed after recovery starts", async () => {
    const sessionKey = "agent:main:recovery-race";
    enqueuePendingDelegate(sessionKey, { task: "skip live-claimed running row" });
    const flow = mockFlows.get("flow-1");
    expect(flow).toBeDefined();
    flow!.status = "running";
    flow!.currentStep = "Released to continuation scheduler";
    flow!.revision = 1;
    flow!.updatedAt = Date.now() + 2_000;

    await recoverPendingContinuationDelegates({
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      maxChainLength: 10,
    });

    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(mockFlows.get("flow-1")?.status).toBe("running");
  });
});
