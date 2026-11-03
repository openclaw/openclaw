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

import { AGENT_LANE_SUBAGENT } from "../../agents/lanes.js";
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
import { updateContinuationRecords } from "./custody/custody-store.js";
import type { ContinuationRecordPatch } from "./custody/custody-store.types.js";
import {
  custodyStateForTest,
  listCustodyRecordsForTest,
  readCustodyRecordForTest,
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
  resolveCommandLaneIdle,
  STALE_UNENDED_SUBAGENT_RUN_MS,
  deleteSubagentSessionForCleanup,
  runWithGatewayRootWorkAdmission,
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  computeBusySkipBackoffMs,
  partitionSupersededWork,
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
  hasLiveOrRecentlyDispatchedContinuationWork,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
  addSubagentRun,
  config,
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

/** One custody record, re-read, with its state JSON parsed. */
async function recordView(recordId: string) {
  return (await custodyRecords()).find((record) => record.recordId === recordId);
}

/** Commit a patch at the record's current revision, as a concurrent writer would. */
async function writeRecordForTest(recordId: string, patch: ContinuationRecordPatch): Promise<void> {
  const record = await readCustodyRecordForTest(recordId);
  if (!record) {
    throw new Error(`expected custody record ${recordId}`);
  }
  const written = await updateContinuationRecords(
    [
      {
        recordId,
        ownerSessionKey: record.ownerSessionKey,
        expectedRevision: record.revision,
        patch: { updatedAt: record.updatedAt, ...patch },
      },
    ],
    { now: record.updatedAt },
  );
  if (written.outcome !== "applied") {
    throw new Error(`expected concurrent custody write to commit: ${written.outcome}`);
  }
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

  it("does not let a busy slow hedge delay running recovery due sooner", async () => {
    const sessionKey = "agent:main:busy-with-running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "running recovery sooner",
    });
    const runningFlow = (await custodyRecords())[0];
    if (!runningFlow) {
      throw new Error("expected running continuation flow");
    }
    await writeRecordForTest(runningFlow.recordId, {
      status: "running",
      updatedAt: Date.now() - 50_000,
    });
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "busy slow hedge",
    });
    mainQueueSize = 1;

    await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - 60_000,
    });
    expect(turnGrants).toHaveLength(0);
    await waitForMockWaiter(laneIdleWaiters, "main");
    mainQueueSize = 0;
    await advanceTimers(5_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    await advanceTimers(5_000);
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("running recovery sooner"),
        }),
      }),
    ]);
  });

  it("keeps the shared idle waiter when a hedge delivers one of several parked rows", async () => {
    const sessionKey = "agent:main:sibling-idle-retry";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "first parked row",
    });
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 5_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 5_000,
      maxChainLength: 8,
      reason: "second parked row",
    });

    await dispatchPendingContinuationWork({ sessionKey });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    await advanceTimers(5_000);
    await flushAsyncWork();

    activeSessions.delete(sessionKey);
    await advanceTimers(55_000);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("first parked row") }),
      }),
    ]);
    expect(replyIdleWaiters.has(sessionKey)).toBe(true);

    resolveReplyRunIdle(sessionKey);
    await waitForTurnGrantCount(2);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("first parked row") }),
      }),
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("second parked row") }),
      }),
    ]);
  });

  it("drives a subagent continuation to completion on the subagent lane when main is busy", async () => {
    const sessionKey = "agent:main:subagent:cross-session-independence-1057";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "cross-session independence",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    expect((await custodyRecords())[0]).toMatchObject({ status: "succeeded" });
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("cross-session independence"),
        }),
        options: expect.objectContaining({
          continuationTrigger: "work-wake",
          lane: AGENT_LANE_SUBAGENT,
        }),
      }),
    ]);
  });

  it("recovers only stale running continuation work", async () => {
    const sessionKey = "agent:main:running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "running recovery",
    });
    const flow = (await custodyRecords())[0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    await writeRecordForTest(flow.recordId, {
      status: "running",
      updatedAt: Date.now(),
    });

    await recoverPendingContinuationWork();

    expect(turnGrants).toHaveLength(0);

    await advanceTimers(60_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("running recovery"),
        }),
      }),
    ]);
  });

  it("does not reclaim stale running work while an in-process reply still owns the session", async () => {
    const sessionKey = "agent:main:active-running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "active running recovery",
    });
    const flow = (await custodyRecords())[0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    await writeRecordForTest(flow.recordId, {
      status: "running",
      updatedAt: Date.now() - 200_000,
    });
    activeSessions.add(sessionKey);

    const result = await recoverPendingContinuationWork();

    expect(result).toEqual({
      sessions: 1,
      dispatched: 0,
      failed: 0,
      reaped: 0,
      terminalNotices: 0,
    });
    expect(await recordView(flow.recordId)).toMatchObject({ status: "running" });
    expect((await recordView(flow.recordId))?.stateJson).not.toMatchObject({
      busySkipCount: expect.any(Number),
    });
    expect(turnGrants).toHaveLength(0);
  });

  it("still finalizes delivered-marked running rows while active-reply recovery is blocked", async () => {
    const sessionKey = "agent:main:active-delivered-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "active delivered recovery",
    });
    const flow = (await custodyRecords())[0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    await writeRecordForTest(flow.recordId, {
      status: "running",
      updatedAt: Date.now() - 200_000,
      stateJson: JSON.stringify({
        ...(flow.stateJson as object),
        succeeded: { point: "optimal", durability: "durable" },
      }),
    });
    activeSessions.add(sessionKey);

    const result = await recoverPendingContinuationWork();

    expect(result).toEqual({
      sessions: 1,
      dispatched: 0,
      failed: 0,
      reaped: 0,
      terminalNotices: 0,
    });
    expect((await recordView(flow.recordId))?.status).toBe("succeeded");
    expect((await recordView(flow.recordId))?.phase).toBe("Same-session continuation turn granted");
    expect(turnGrants).toHaveLength(0);
  });

  it("finalizes a completed turn when the gateway starts draining after the grant", async () => {
    const sessionKey = "agent:main:draining-after-grant";
    mockSessionStore[sessionKey] = { sessionKey };
    drainAfterReply = true;
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain after grant",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    expect((await custodyRecords())[0]).toMatchObject({ status: "succeeded" });
    expect(systemEvents).toEqual([]);

    drainAfterReply = false;
    gatewayDraining = false;
    await advanceTimers(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("drain after grant") }),
      }),
    ]);
  });

  it("requeues when gateway drain prevents the turn grant", async () => {
    const sessionKey = "agent:main:draining-before-grant";
    mockSessionStore[sessionKey] = { sessionKey };
    gatewayDraining = true;
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain before grant",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toEqual([]);
    expect(systemEvents).toEqual([]);
    expect((await custodyRecords())[0]).toMatchObject({
      status: "queued",
      phase: "Requeued same-session continuation wake",
    });

    gatewayDraining = false;
    await advanceTimers(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("drain before grant") }),
      }),
    ]);
  });

  it("requeues when getReply returns only the gateway-draining notice", async () => {
    const sessionKey = "agent:main:drain-payload";
    mockSessionStore[sessionKey] = { sessionKey };
    drainAfterReply = true;
    replyPayloadOverride = {
      text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
    };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain payload",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toEqual([]);
    expect(systemEvents).toEqual([]);
    expect((await custodyRecords())[0]).toMatchObject({
      status: "queued",
      phase: "Requeued same-session continuation wake",
    });
  });

  it("requeues transient turn-grant errors instead of failing the durable work", async () => {
    const sessionKey = "agent:main:transient-error";
    mockSessionStore[sessionKey] = { sessionKey };
    replyError = new Error("provider unavailable");
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "transient proof",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    const flow = (await custodyRecords())[0];
    expect(flow).toMatchObject({
      status: "queued",
      phase: "Requeued same-session continuation wake",
    });
    expect(flow?.stateJson).toMatchObject({ retryCount: 1 });

    replyError = undefined;
    await advanceTimers(5_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("transient proof") }),
      }),
    ]);
  });
});
