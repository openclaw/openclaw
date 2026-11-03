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
// mock-isolation: The helper returns the real authority module with every export kept, adding in-flight counting.
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
  resolveReplyRunIdle,
  resolveCommandLaneIdle,
  waitForMockWaiter,
  waitForTurnGrantCount,
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
  recoverPendingContinuationWork,
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

  it("enqueues warning events only for non-retryable skips", async () => {
    const sessionKey = "agent:main:missing";
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "missing session",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 1, reaped: 0 });
    expect(systemEvents).toEqual([
      expect.objectContaining({ text: expect.stringContaining("was not granted") }),
    ]);
  });

  it("delivers a distinct wake for every continue_work election scheduled in one turn", async () => {
    // Regression for N continue_work() calls in one model turn must each
    // deliver their own wake at their own offset. The single-variable capture
    // dropped all but the last; the batch helper fans out all N, and the
    // wake-timer re-arms for the soonest pending after each fire.
    const sessionKey = "agent:main:multi-fanout";
    mockSessionStore[sessionKey] = { sessionKey };

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-multi",
      },
      requests: [
        { reason: "work-A", delaySeconds: 1 },
        { reason: "work-B", delaySeconds: 2 },
        { reason: "work-C", delaySeconds: 3 },
      ],
      config,
      parentRunId: "run-multi",
    });

    expect(batch).toMatchObject({ scheduledCount: 3, cappedCount: 0, capped: false });
    expect(turnGrants).toHaveLength(0);

    // Advance one offset at a time. Each fire delivers exactly one wake and
    // re-arms for the next pending dueAt — proving distinct delivery, not the
    // single collapsed wake of the regression. `advanceTimersByTimeAsync` only
    // runs timers due within the window (unlike `flushTimers`, which drains the
    // re-armed future timers too).
    await advanceTimers(1_000);
    expect(turnGrants).toHaveLength(1);
    expect(turnGrants[0]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-A") }),
    });

    await advanceTimers(1_000);
    expect(turnGrants).toHaveLength(2);
    expect(turnGrants[1]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-B") }),
    });

    await advanceTimers(1_000);
    expect(turnGrants).toHaveLength(3);
    expect(turnGrants[2]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-C") }),
    });
  });

  it("bounds the observed 3x same-turn continue_work delays as three scheduled terminal wakes", async () => {
    const sessionKey = "agent:main:three-continue-work";
    mockSessionStore[sessionKey] = { sessionKey };
    const threeWorkConfig = { ...config, maxDelayMs: 65_000 } satisfies ContinuationRuntimeConfig;

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-three-work",
      },
      requests: [
        { reason: "1 of 3 - did this fire for you", delaySeconds: 55 },
        { reason: "2 of 3 - did this turn compress with the next", delaySeconds: 60 },
        { reason: "3 of 3 - or this one?", delaySeconds: 61 },
      ],
      config: threeWorkConfig,
    });

    expect(batch).toMatchObject({ scheduledCount: 3, cappedCount: 0, capped: false });
    expect(turnGrants).toHaveLength(0);

    await advanceTimers(55_000);
    expect(turnGrants).toHaveLength(1);
    await advanceTimers(5_000);
    expect(turnGrants).toHaveLength(2);
    await advanceTimers(1_000);
    expect(turnGrants).toHaveLength(3);

    expect(
      turnGrants.map((grant) => (grant as { context: { Body: string } }).context.Body),
    ).toEqual([
      expect.stringContaining("1 of 3 - did this fire for you"),
      expect.stringContaining("2 of 3 - did this turn compress with the next"),
      expect.stringContaining("3 of 3 - or this one?"),
    ]);
    expect((await custodyRecords()).map((flow) => flow.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(
      (await custodyRecords()).map(
        (flow) =>
          (
            flow.stateJson as {
              busySkipCount?: number;
              parentRunId?: string;
              turnGrantedAt?: number;
            }
          ).busySkipCount,
      ),
    ).toEqual([0, 0, 0]);
    expect(
      (await custodyRecords()).map(
        (flow) => (flow.stateJson as { parentRunId?: string }).parentRunId,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("parks a 3x same-turn continue_work burst while requests are in flight without a tight wake loop", async () => {
    const sessionKey = "agent:main:three-continue-work-busy";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    const threeWorkConfig = { ...config, maxDelayMs: 65_000 } satisfies ContinuationRuntimeConfig;

    await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-three-work-busy",
      },
      requests: [
        { reason: "1 of 3 - busy", delaySeconds: 55 },
        { reason: "2 of 3 - busy", delaySeconds: 60 },
        { reason: "3 of 3 - busy", delaySeconds: 61 },
      ],
      config: threeWorkConfig,
    });

    await advanceTimers(61_000);
    await flushAsyncWork();

    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(
      (await custodyRecords()).map((flow) => ({
        status: flow.status,
        busySkipCount: (flow.stateJson as { busySkipCount?: number }).busySkipCount,
        anchorPending: (flow.stateJson as { anchorPending?: boolean }).anchorPending,
        idleRetry: (flow.stateJson as { idleRetry?: unknown }).idleRetry,
      })),
    ).toEqual([
      {
        status: "queued",
        busySkipCount: undefined,
        anchorPending: true,
        idleRetry: expect.objectContaining({ trigger: "reply-run-ended" }),
      },
      {
        status: "queued",
        busySkipCount: undefined,
        anchorPending: true,
        idleRetry: expect.objectContaining({ trigger: "reply-run-ended" }),
      },
      {
        status: "queued",
        busySkipCount: undefined,
        anchorPending: true,
        idleRetry: expect.objectContaining({ trigger: "reply-run-ended" }),
      },
    ]);

    activeSessions.delete(sessionKey);
    const recovered = await dispatchPendingContinuationWork({ sessionKey, includeIdleRetry: true });

    expect(recovered).toEqual({ dispatched: 3, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(3);
    expect((await custodyRecords()).map((flow) => flow.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("does not let a delayed batch election postpone an already-due zero-delay wake", async () => {
    const sessionKey = "agent:main:zero-delay-batch";
    mockSessionStore[sessionKey] = { sessionKey };

    await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-zero-delay",
      },
      requests: [
        { reason: "immediate batch work", delaySeconds: 0 },
        { reason: "delayed batch work", delaySeconds: 5 },
      ],
      config,
    });

    await advanceTimers(0);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("immediate batch work") }),
      }),
    ]);

    await advanceTimers(4_999);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(1);

    await advanceTimers(1);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("immediate batch work") }),
      }),
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("delayed batch work") }),
      }),
    ]);
  });

  it("schedules the valid elections and caps the overflow without dropping the earlier ones", async () => {
    // Partial-success is load-bearing: when the cumulative chain cap rejects a
    // later election, the earlier valid ones must still schedule and deliver.
    const sessionKey = "agent:main:partial-cap";
    mockSessionStore[sessionKey] = { sessionKey };
    const cappedConfig = { ...config, maxChainLength: 2 } satisfies ContinuationRuntimeConfig;

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-partial",
      },
      requests: [
        { reason: "fit-1", delaySeconds: 1 },
        { reason: "fit-2", delaySeconds: 1 },
        { reason: "over-cap", delaySeconds: 1 },
      ],
      config: cappedConfig,
      parentRunId: "run-partial",
    });

    expect(batch).toMatchObject({ scheduledCount: 2, cappedCount: 1, capped: true });
    expect(batch.chainState.currentChainCount).toBe(2);

    await advanceTimers(1_000);
    await flushTimers();

    const deliveredReasons = turnGrants.map(
      (grant) => (grant as { context: { Body: string } }).context.Body,
    );
    expect(deliveredReasons).toHaveLength(2);
    expect(deliveredReasons.some((body) => body.includes("fit-1"))).toBe(true);
    expect(deliveredReasons.some((body) => body.includes("fit-2"))).toBe(true);
    expect(deliveredReasons.some((body) => body.includes("over-cap"))).toBe(false);
  });

  it("does not let a hedge reclaim freshly running continuation work", async () => {
    const sessionKey = "agent:main:fresh-running";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "fresh running",
    });
    const runningFlow = (await custodyRecords())[0];
    if (!runningFlow) {
      throw new Error("expected mock flow");
    }
    await writeRecordForTest(runningFlow.recordId, {
      status: "running",
      updatedAt: Date.now(),
    });

    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 1,
      },
      request: { delaySeconds: 0, reason: "new queued" },
      config: { ...config, defaultDelayMs: 0, minDelayMs: 0 },
    });

    await advanceTimers(0);
    await flushAsyncWork();

    expect((await recordView(runningFlow.recordId))?.status).toBe("running");
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("new queued") }),
      }),
    ]);
  });

  it("never supersedes a recovered running wake folded against a newer queued election", async () => {
    // End-to-end proof that the PRE-claim status is carried through
    // consumePendingWork into partitionSupersededWork: a stale, recovered
    // `running` wake co-drained with a newer `queued` election must DRIVE, not
    // be finished-as-superseded. Without the carry-status guard the running
    // wake (stale, not newest) would be folded and only the queued one would run.
    const sessionKey = "agent:main:recovered-running-fold";
    mockSessionStore[sessionKey] = { sessionKey };
    const now = Date.now();

    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: now - 500_000,
      dueAt: now - 500_000, // matured and stale (overdue >> 120s grace)
      maxChainLength: 8,
      reason: "recovered running",
    });
    const runningFlow = (await custodyRecords())[0];
    if (!runningFlow) {
      throw new Error("expected running mock flow");
    }
    // older than the 60s recovery staleness window
    await writeRecordForTest(runningFlow.recordId, {
      status: "running",
      updatedAt: now - 200_000,
    });

    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: now - 1_000, // newest election
      dueAt: now - 1_000, // matured
      maxChainLength: 8,
      reason: "newest queued",
    });

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: now - 60_000,
    });

    expect(result).toEqual({ dispatched: 2, failed: 0, reaped: 0 });
    const bodies = turnGrants.map((grant) => (grant as { context: { Body: string } }).context.Body);
    expect(bodies.some((body) => body.includes("recovered running"))).toBe(true);
    expect(bodies.some((body) => body.includes("newest queued"))).toBe(true);
    expect(systemEvents.some((event) => (event as { text: string }).text.includes("folded"))).toBe(
      false,
    );
  });
});
