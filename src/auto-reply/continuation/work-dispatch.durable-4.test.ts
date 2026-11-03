import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const turnGrants: unknown[] = [];
const systemEvents: unknown[] = [];
const activeQueueDeliveries: unknown[] = [];
const workTransitionEvents: string[] = [];
const replyRegistryReceivers = new Set<unknown>();
const activeSessions = new Set<string>();
const replyIdleWaiters = new Map<string, Array<(idle: boolean) => void>>();
const laneIdleWaiters = new Map<string, Array<(idle: boolean) => void>>();
let mainQueueSize = 0;
let gatewayDraining = false;
let replyError: Error | undefined;
let commandLaneIdleError: Error | undefined;
let drainAfterReply = false;
let replyPayloadOverride: unknown;
let activeQueueMode: "delivered" | "queued-without-proof" | "rejected" = "delivered";
let activeQueueHandleAvailable = true;
const mockSessionStore: Record<string, unknown> = {};
const loadSessionEntryMock = vi.fn();
let mockStorePath = WORK_DISPATCH_STORE_PATH;
let observeSubordinateAdmission = false;
const observedSubordinateAdmissionClosed: boolean[] = [];
// test state: toggle continuation enablement (disabled-gate), capture the
// active diagnostic traceparent at reply time (traceparent re-entry), and force
// a revision race after the turn ran (failed durable delivered-mark).
let continuationEnabledForTest = true;
const capturedReplyTraceparents: Array<string | undefined> = [];
let bumpWorkRevisionOnReply = false;
const { emitContinuationWorkFireSpanMock, resolveContinuationTraceparentMock } = vi.hoisted(() => ({
  emitContinuationWorkFireSpanMock: vi.fn(),
  resolveContinuationTraceparentMock: vi.fn((traceparent: string | undefined) => traceparent),
}));

function removeWaiter(
  waiters: Map<string, Array<(idle: boolean) => void>>,
  key: string,
  waiter: (idle: boolean) => void,
): void {
  const current = waiters.get(key);
  if (!current) {
    return;
  }
  const index = current.indexOf(waiter);
  if (index >= 0) {
    current.splice(index, 1);
  }
  if (current.length === 0) {
    waiters.delete(key);
  }
}

function waitForMockIdle(
  waiters: Map<string, Array<(idle: boolean) => void>>,
  key: string,
  isIdle: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isIdle()) {
    return Promise.resolve(true);
  }
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let abortHandler: (() => void) | undefined;
    const finish = (idle: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      removeWaiter(waiters, key, finish);
      if (abortHandler) {
        signal?.removeEventListener("abort", abortHandler);
      }
      resolve(idle);
    };
    const current = waiters.get(key) ?? [];
    current.push(finish);
    waiters.set(key, current);
    if (signal) {
      abortHandler = () => finish(false);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

function resolveReplyRunIdle(sessionKey: string): void {
  activeSessions.delete(sessionKey);
  const waiters = replyIdleWaiters.get(sessionKey) ?? [];
  for (const finish of Array.from(waiters)) {
    finish(true);
  }
}

function resolveCommandLaneIdle(lane = "main"): void {
  mainQueueSize = 0;
  const waiters = laneIdleWaiters.get(lane) ?? [];
  for (const finish of Array.from(waiters)) {
    finish(true);
  }
}

async function flushAsyncWork(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
  await settleWorkDispatchCustody();
}

async function waitForMockWaiter(
  waiters: Map<string, Array<(idle: boolean) => void>>,
  key: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((waiters.get(key)?.length ?? 0) > 0) {
      return;
    }
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
  }
  throw new Error(`expected idle waiter for ${key}`);
}

async function waitForTurnGrantCount(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (turnGrants.length >= count) {
      return;
    }
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
  }
  throw new Error(`expected at least ${count} turn grant(s), got ${turnGrants.length}`);
}

// mock-isolation: Work dispatch reads a synthetic session-store config, never the operator's config file.
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: "test-store" } }),
}));

// mock-isolation: The session store path comes from the test, never the operator's state dir.
vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => mockStorePath,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntry: (scope: { sessionKey: string }) => loadSessionEntryMock(scope),
}));

vi.mock("../../sessions/session-key-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-key-utils.js")>()),
  parseAgentSessionKey: (sessionKey: string) => {
    const match = /^agent:([^:]+)/.exec(sessionKey);
    return match ? { agentId: match[1] } : undefined;
  },
  isSubagentSessionKey: (sessionKey: string) => {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) {
      return false;
    }
    const lower = sessionKey.toLowerCase();
    if (lower.startsWith("subagent:")) {
      return true;
    }
    return lower.replace(/^agent:[^:]+:/, "").startsWith("subagent:");
  },
}));

// Continuation reads the session controller through one memoized accessor
// (getContinuationReplyRunRegistry). Scripted reads drive active and idle
// sessions, and each records its receiver: the accessor object.
vi.mock("../../sessions/session-controller.queries.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../sessions/session-controller.queries.js")>();
  return {
    ...actual,
    isSessionRunActiveForKey(this: unknown, sessionKey: string) {
      replyRegistryReceivers.add(this);
      return activeSessions.has(sessionKey);
    },
    resolveActiveSessionRunId: (sessionKey: string) =>
      activeSessions.has(sessionKey) ? `active-session:${sessionKey}` : undefined,
    // The scripted active run's operation handle; other ids resolve through the controller.
    resolveActiveReplyOperationForSessionId: (sessionId: string) =>
      sessionId.startsWith("active-session:")
        ? { sessionId }
        : actual.resolveActiveReplyOperationForSessionId(sessionId),
  };
});

vi.mock("../../sessions/session-controller.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.js")>()),
  waitForSessionRunIdle(
    this: unknown,
    sessionKey: string,
    _timeoutMs?: number | null,
    opts?: { signal?: AbortSignal },
  ) {
    replyRegistryReceivers.add(this);
    return waitForMockIdle(
      replyIdleWaiters,
      sessionKey,
      () => !activeSessions.has(sessionKey),
      opts?.signal,
    );
  },
}));

// mock-isolation: A scripted run-handle check stands in for live embedded agent runs.
vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  isEmbeddedAgentRunHandleActive: vi.fn(() => activeQueueHandleAvailable),
}));

// Scripted steer outcomes stand in for the active run's transcript-committed fold note.
vi.mock("../../sessions/session-controller.steer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.steer.js")>()),
  steerSessionControllerOperation: vi.fn(
    async ({ operation, text }: { operation?: { sessionId: string }; text: string }) => {
      workTransitionEvents.push("fold-transcript-committed");
      activeQueueDeliveries.push({ sessionId: operation?.sessionId, text });
      if (activeQueueMode === "delivered") {
        return { status: "accepted" as const };
      }
      if (activeQueueMode === "queued-without-proof") {
        const result = { transcriptCommit: "unconfirmed" as const, errorMessage: "reply_run" };
        return { status: "accepted" as const, result };
      }
      return { status: "rejected" as const, reason: "no_active_run" as const };
    },
  ),
}));

// mock-isolation: Scripted lane size, drain and idle waits replace the process-wide command queue.
vi.mock("../../process/command-queue.js", () => ({
  getQueueSize: () => mainQueueSize,
  isGatewayDraining: () => gatewayDraining,
  waitForCommandLaneIdle: async (
    lane = "main",
    _timeoutMs?: number,
    opts?: { signal?: AbortSignal },
  ) => ({
    idle: await (async () => {
      if (commandLaneIdleError) {
        throw commandLaneIdleError;
      }
      return await waitForMockIdle(laneIdleWaiters, lane, () => mainQueueSize <= 0, opts?.signal);
    })(),
  }),
}));

// mock-isolation: A recorded turn grant replaces the reply pipeline, so no provider or transcript runs.
vi.mock("../reply/get-reply.js", () => ({
  getReplyFromConfig: vi.fn(async (context: unknown, options: unknown, cfg: unknown) => {
    workTransitionEvents.push("provider-called");
    if (observeSubordinateAdmission) {
      const { isGatewaySubordinateWorkAdmissionClosed } =
        await import("../../process/gateway-work-admission.js");
      observedSubordinateAdmissionClosed.push(isGatewaySubordinateWorkAdmissionClosed());
    }
    // Capture the active diagnostic traceparent so tests can assert the
    // continuation turn re-enters the persisted work.traceparent.
    const { formatActiveDiagnosticTraceparent } =
      await import("../../infra/diagnostic-trace-context.js");
    capturedReplyTraceparents.push(formatActiveDiagnosticTraceparent());
    // Simulate a revision/cancel race landing between claim and delivered-mark:
    // bump every continuation-work flow revision so markPendingWorkDelivered
    // fails its expected-revision check after the turn already ran.
    if (bumpWorkRevisionOnReply) {
      const { bumpLiveWorkRecordRevisions } =
        await import("./work-dispatch-flow-mock.test-support.js");
      await bumpLiveWorkRecordRevisions(await import("./custody/custody-store.js"));
    }
    if (replyError) {
      throw replyError;
    }
    if (replyPayloadOverride !== undefined) {
      if (drainAfterReply) {
        gatewayDraining = true;
      }
      return replyPayloadOverride;
    }
    turnGrants.push({ context, options, cfg });
    if (drainAfterReply) {
      gatewayDraining = true;
    }
    return [{ text: "ok" }];
  }),
}));

// mock-isolation: System events are captured instead of entering the process-wide event queue.
vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEventRaw: (text: string, options: unknown) => {
    systemEvents.push({ text, options });
  },
}));

// mock-isolation: Continuation spans are captured without the process-wide tracer.
vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationWorkFireSpan: emitContinuationWorkFireSpanMock,
  emitContinuationWorkSpan: vi.fn(),
  resolveContinuationTraceparent: resolveContinuationTraceparentMock,
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveContinuationRuntimeConfig: () => ({
      enabled: continuationEnabledForTest,
      maxChainLength: 8,
      maxDelegatesPerTurn: 4,
      maxPendingWork: 32,
      defaultDelayMs: 1_000,
      minDelayMs: 1_000,
      maxDelayMs: 60_000,
      costCapTokens: 0,
      crossSessionTargeting: "enabled",
      busySkipBackoff: { baseMs: 1_000, ceilingMs: 60_000, factor: 2 },
    }),
  };
});

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const logger = {
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return {
    ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
    createSubsystemLogger: () => logger,
  };
});

// mock-isolation: The helper returns the real custody store with every export kept, adding test hooks and in-flight counting.
vi.mock("./custody/custody-store.js", async (importOriginal) =>
  (await import("./work-dispatch-flow-mock.test-support.js")).wrapCustodyStoreForWorkDispatch(
    await importOriginal(),
  ),
);
vi.mock("./work-recipient-authority.js", async (importOriginal) =>
  (
    await import("./work-dispatch-flow-mock.test-support.js")
  ).wrapWorkRecipientAuthorityForWorkDispatch(await importOriginal()),
);

import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { STALE_UNENDED_SUBAGENT_RUN_MS } from "../../agents/subagents/registry/subagent-run-liveness.js";
import {
  deleteSubagentSessionForCleanup,
  resetSubagentSessionCleanupForTests,
} from "../../agents/subagents/registry/subagent-session-cleanup.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest as runWithGatewayRootWorkAdmission } from "../../process/gateway-work-admission.test-helpers.js";
import { getReplyFromConfig } from "../reply/get-reply.js";
import {
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
} from "../reply/no-op-rearm-guard.js";
import {
  custodyStateForTest,
  listCustodyRecordsForTest,
  useContinuationCustodyTestState,
} from "./custody/custody.test-support.js";
import {
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
} from "./delegate-store.js";
import type { ContinuationRuntimeConfig } from "./types.js";
import {
  describeWorkTransition,
  resetWorkDispatchCustodyHooks,
  settleWorkDispatchCustody,
  WORK_DISPATCH_STORE_PATH,
  workDispatchCustodyHooks,
} from "./work-dispatch-flow-mock.test-support.js";
import {
  dispatchPendingContinuationWork,
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  computeBusySkipBackoffMs,
  partitionSupersededWork,
  recoverPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
} from "./work-dispatch.js";
import {
  consumePendingWork,
  hasLiveOrRecentlyDispatchedContinuationWork,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
} from "./work-store.js";
import { enqueuePendingWork } from "./work-store.test-support.js";

const getReplyFromConfigMock = vi.mocked(getReplyFromConfig);

function addSubagentRun(childSessionKey: string, overrides: Partial<SubagentRunRecord> = {}): void {
  const runId = overrides.runId ?? `run-${childSessionKey}-${subagentRuns.size + 1}`;
  subagentRuns.set(runId, {
    runId,
    childSessionKey,
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:requester",
    requesterDisplayKey: overrides.requesterDisplayKey ?? "requester",
    task: overrides.task ?? "delegated task",
    cleanup: overrides.cleanup ?? "keep",
    createdAt: overrides.createdAt ?? Date.now(),
    execution: overrides.execution ?? { status: "running" },
    ...overrides,
  });
}

const config = {
  enabled: true,
  maxChainLength: 8,
  maxDelegatesPerTurn: 4,
  maxPendingWork: 32,
  defaultDelayMs: 1_000,
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  costCapTokens: 0,
  crossSessionTargeting: "enabled",
  busySkipBackoff: { baseMs: 1_000, ceilingMs: 60_000, factor: 2 },
} satisfies ContinuationRuntimeConfig;

async function flushTimers(): Promise<void> {
  await settleWorkDispatchCustody();
  await vi.runOnlyPendingTimersAsync();
  await settleWorkDispatchCustody();
}

async function claimMaturedWork(sessionKey: string) {
  const enqueued = await enqueuePendingWork({
    sessionKey,
    hop: 1,
    delayMs: 0,
    electedAt: Date.now(),
    dueAt: Date.now(),
    maxChainLength: 8,
    reason: "immutable transition characterization",
  });
  if (!enqueued) {
    throw new Error("expected continuation work enqueue");
  }
  const [work] = await consumePendingWork(sessionKey);
  if (!work) {
    throw new Error("expected matured continuation work claim");
  }
  return work;
}
const splitLintUse = [
  fs,
  os,
  path,
  resolveReplyRunIdle,
  STALE_UNENDED_SUBAGENT_RUN_MS,
  deleteSubagentSessionForCleanup,
  runWithGatewayRootWorkAdmission,
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  computeBusySkipBackoffMs,
  partitionSupersededWork,
  recoverPendingContinuationWork,
  scheduleContinuationWorkBatch,
  hasLiveOrRecentlyDispatchedContinuationWork,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
  addSubagentRun,
  claimMaturedWork,
];
void splitLintUse;

useContinuationCustodyTestState();

/** Advance fake time; custody work started before or by the fired timers settles on both sides. */
async function advanceTimers(ms: number): Promise<void> {
  await settleWorkDispatchCustody();
  await vi.advanceTimersByTimeAsync(ms);
  await settleWorkDispatchCustody();
}

/**
 * Custody records in creation order, optionally for one owner, with the state
 * JSON parsed so assertions can match its fields.
 */
async function custodyRecords(ownerSessionKey?: string) {
  const records = await listCustodyRecordsForTest(ownerSessionKey ? { ownerSessionKey } : {});
  const views = [];
  for (const record of records) {
    views.push({ ...record, stateJson: custodyStateForTest(record) });
  }
  return views;
}

describe("durable continuation_work dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    turnGrants.length = 0;
    systemEvents.length = 0;
    activeQueueDeliveries.length = 0;
    workTransitionEvents.length = 0;
    replyRegistryReceivers.clear();
    activeSessions.clear();
    replyIdleWaiters.clear();
    laneIdleWaiters.clear();
    mainQueueSize = 0;
    gatewayDraining = false;
    replyError = undefined;
    commandLaneIdleError = undefined;
    drainAfterReply = false;
    replyPayloadOverride = undefined;
    activeQueueMode = "delivered";
    activeQueueHandleAvailable = true;
    observeSubordinateAdmission = false;
    observedSubordinateAdmissionClosed.length = 0;
    for (const key of Object.keys(mockSessionStore)) {
      delete mockSessionStore[key];
    }
    loadSessionEntryMock
      .mockReset()
      .mockImplementation(
        ({ sessionKey }: { sessionKey: string }) => mockSessionStore[sessionKey.trim()],
      );
    mockStorePath = WORK_DISPATCH_STORE_PATH;
    resetWorkDispatchCustodyHooks();
    workDispatchCustodyHooks.onApplied = (update) => {
      const transition = describeWorkTransition(update);
      if (transition) {
        workTransitionEvents.push(transition);
      }
    };
    subagentRuns.clear();
    getReplyFromConfigMock.mockClear();
    continuationEnabledForTest = true;
    capturedReplyTraceparents.length = 0;
    bumpWorkRevisionOnReply = false;
    emitContinuationWorkFireSpanMock.mockReset();
    resolveContinuationTraceparentMock
      .mockReset()
      .mockImplementation((traceparent: string | undefined) => traceparent);
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
    resetGatewayWorkAdmission();
  });

  afterEach(async () => {
    await settleWorkDispatchCustody();
    subagentRuns.clear();
    replyIdleWaiters.clear();
    laneIdleWaiters.clear();
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
    resetGatewayWorkAdmission();
    commandLaneIdleError = undefined;
    vi.useRealTimers();
  });

  it("retries main-session work from the command-lane idle event instead of polling queue busy", async () => {
    const sessionKey = "agent:main:queued-user-turn";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "queued user turn",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    expect((await custodyRecords())[0]).toMatchObject({
      status: "queued",
      phase: "Requeued same-session continuation wake",
      stateJson: expect.objectContaining({
        dueAt: Date.now() + 60_000,
        idleRetry: expect.objectContaining({
          trigger: "command-lane-idle",
          reasonCategory: "follow-up-work",
        }),
      }),
    });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();

    await waitForMockWaiter(laneIdleWaiters, "main");
    await advanceTimers(1_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    resolveCommandLaneIdle();
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("queued user turn"),
        }),
      }),
    ]);
  });

  it("recovers queued idle-retry work promptly when idle waiter registration fails", async () => {
    const sessionKey = "agent:main:idle-waiter-registration-fails";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    commandLaneIdleError = new Error("idle waiter unavailable");
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "recover after idle waiter failure",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    expect((await custodyRecords())[0]).toMatchObject({
      status: "queued",
      stateJson: expect.objectContaining({
        dueAt: Date.now() + 60_000,
        idleRetry: expect.objectContaining({ trigger: "command-lane-idle" }),
      }),
    });

    commandLaneIdleError = undefined;
    mainQueueSize = 0;
    await advanceTimers(30_000);
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("recover after idle waiter failure"),
        }),
      }),
    ]);
  });

  it("keeps idle-retry failure recovery when normal scheduling arms the session timer", async () => {
    const sessionKey = "agent:main:idle-waiter-failure-plus-normal-work";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    commandLaneIdleError = new Error("idle waiter unavailable");
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "parked after idle waiter failure",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });
    // The idle waiter must fail (arming its recovery timer) before the lane recovers.
    await flushAsyncWork();

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    commandLaneIdleError = undefined;
    mainQueueSize = 0;

    await scheduleContinuationWork({
      config,
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
      },
      request: {
        delaySeconds: 45,
        reason: "normal work should not clobber idle-retry recovery",
      },
    });

    await advanceTimers(30_000);
    await waitForTurnGrantCount(1);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("parked after idle waiter failure"),
        }),
      }),
    ]);

    await advanceTimers(15_000);
    await waitForTurnGrantCount(2);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("parked after idle waiter failure"),
        }),
      }),
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("normal work should not clobber idle-retry recovery"),
        }),
      }),
    ]);
  });

  it("busy-skips a main-session continuation when the global main lane is busy", async () => {
    const sessionKey = "agent:main:main-lane-busy-positive-control";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "main lane positive control",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
  });

  it("keeps a slow hedge as the safety net when an idle event is lost", async () => {
    const sessionKey = "agent:main:lost-idle-event";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "follow up after busy turn",
    });

    await dispatchPendingContinuationWork({ sessionKey });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    activeSessions.delete(sessionKey);

    await advanceTimers(59_999);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    await advanceTimers(1);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("follow up after busy turn"),
        }),
      }),
    ]);
  });

  it("parks wait-shaped continuation rows behind idle events without a high-frequency wake loop", async () => {
    const sessionKey = "agent:main:wait-shaped";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    await enqueuePendingWork({
      sessionKey,
      hop: 41,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 200,
      reason: "Clearing wake cascade. Yielding and standing by.",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    const flow = (await custodyRecords())[0];
    expect(flow).toMatchObject({
      status: "queued",
      stateJson: expect.objectContaining({
        dueAt: Date.now() + 60_000,
        idleRetry: {
          trigger: "reply-run-ended",
          reasonCategory: "wait-shaped",
          armedAt: Date.now(),
        },
      }),
    });

    await advanceTimers(1_000);
    await flushAsyncWork();

    expect(turnGrants).toHaveLength(0);
    expect((await custodyRecords())[0]?.status).toBe("queued");
  });

  it("terminal-parks a continuation work row without a provider call once the no-op replay streak is tripped", async () => {
    const sessionKey = "agent:main:noop-rearm";
    mockSessionStore[sessionKey] = { sessionKey };

    // Seed the per-session no-op streak to the threshold via self-rearm no-op
    // outcomes, as repeated low-value continuation turns would in production.
    for (let i = 0; i < DEFAULT_NO_OP_REARM_THRESHOLD; i += 1) {
      recordNoOpRearmOutcome({
        sessionKey,
        wakeClass: { kind: "self_rearm", source: "continuation" },
        runId: `seed-${i}`,
        outcome: { kind: "no_op", reason: "seed" },
      });
    }

    await enqueuePendingWork({
      sessionKey,
      hop: 12,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 200,
      reason: "Holding off-board and standing by.",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    // The guard blocks before getReplyFromConfig: no provider turn is bought.
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 0, failed: 1, reaped: 0 });
    // The row is superseded (clean terminal: finishFlow), not requeued or failed,
    // so it stops re-arming and emits no re-waking system warning.
    const flow = (await custodyRecords())[0];
    expect(flow?.status).toBe("succeeded");
    expect(flow?.endedAt).toBeDefined();
    expect(String(flow?.phase)).toContain("superseded");
    expect(systemEvents).toHaveLength(0);
  });

  it("does not let a busy slow hedge delay another continuation due sooner", async () => {
    const sessionKey = "agent:main:busy-with-sooner-sibling";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "busy now",
    });
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 5_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 5_000,
      maxChainLength: 8,
      reason: "due sooner than busy hedge",
    });

    await dispatchPendingContinuationWork({ sessionKey });

    await advanceTimers(4_999);
    await flushAsyncWork();
    const siblingBeforeDue = (await custodyRecords()).find((flow) =>
      String((flow.stateJson as { reason?: string } | undefined)?.reason).includes("due sooner"),
    );
    if (!siblingBeforeDue) {
      throw new Error("expected sibling continuation flow");
    }
    expect(
      (siblingBeforeDue.stateJson as { busySkipCount?: number }).busySkipCount,
    ).toBeUndefined();

    await advanceTimers(1);
    await flushAsyncWork();

    const siblingAfterDue = (await custodyRecords()).find((flow) =>
      String((flow.stateJson as { reason?: string } | undefined)?.reason).includes("due sooner"),
    );
    if (!siblingAfterDue) {
      throw new Error("expected sibling continuation flow");
    }
    expect((siblingAfterDue.stateJson as { busySkipCount?: number }).busySkipCount).toBe(1);
    expect(turnGrants).toHaveLength(0);
  });
});
