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
const drainAfterReply = false;
const replyPayloadOverride: unknown = undefined;
const activeQueueMode: "delivered" | "queued-without-proof" | "rejected" = "delivered";

function getReplyError(): Error | string | undefined {
  return undefined;
}

function getCommandLaneIdleError(): Error | string | undefined {
  return undefined;
}
const activeQueueHandleAvailable = true;
const mockSessionStore: Record<string, unknown> = {};
const loadSessionEntryMock = vi.fn();
const mockStorePath = WORK_DISPATCH_STORE_PATH;
const observeSubordinateAdmission = false;
const observedSubordinateAdmissionClosed: boolean[] = [];
// test state: toggle continuation enablement (disabled-gate), capture the
// active diagnostic traceparent at reply time (traceparent re-entry), and force
// a revision race after the turn ran (failed durable delivered-mark).
const continuationEnabledForTest = true;
const capturedReplyTraceparents: Array<string | undefined> = [];
const bumpWorkRevisionOnReply = false;
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
      const commandLaneIdleError = getCommandLaneIdleError();
      if (commandLaneIdleError) {
        throw commandLaneIdleError instanceof Error
          ? commandLaneIdleError
          : new Error(commandLaneIdleError);
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
    const replyError = getReplyError();
    if (replyError) {
      throw replyError instanceof Error ? replyError : new Error(replyError);
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
  const [claimedWork] = await consumePendingWork(sessionKey);
  if (!claimedWork) {
    throw new Error("expected matured continuation work claim");
  }
  return claimedWork;
}
const splitLintUse = [
  fs,
  os,
  path,
  mockSessionStore,
  resolveReplyRunIdle,
  resolveCommandLaneIdle,
  waitForMockWaiter,
  waitForTurnGrantCount,
  STALE_UNENDED_SUBAGENT_RUN_MS,
  deleteSubagentSessionForCleanup,
  resetSubagentSessionCleanupForTests,
  resetGatewayWorkAdmission,
  runWithGatewayRootWorkAdmission,
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
  dispatchPendingContinuationWork,
  bucket1ReapVerdict,
  recoverPendingContinuationWork,
  hasLiveOrRecentlyDispatchedContinuationWork,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
  getReplyFromConfigMock,
  addSubagentRun,
  flushTimers,
  claimMaturedWork,
];
void splitLintUse;

useContinuationCustodyTestState();

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

describe("Pillar-0 computeBusySkipBackoffMs (exp-backoff)", () => {
  const params = (ceilingMs: number) => ({ baseMs: 1_000, ceilingMs, factor: 2 });
  it("grows by factor per consecutive busy-skip and caps at the ceiling", () => {
    const p = params(60_000);
    expect(computeBusySkipBackoffMs(0, p)).toBe(1_000);
    expect(computeBusySkipBackoffMs(1, p)).toBe(2_000);
    expect(computeBusySkipBackoffMs(2, p)).toBe(4_000);
    expect(computeBusySkipBackoffMs(3, p)).toBe(8_000);
    expect(computeBusySkipBackoffMs(4, p)).toBe(16_000);
    expect(computeBusySkipBackoffMs(5, p)).toBe(32_000);
    expect(computeBusySkipBackoffMs(6, p)).toBe(60_000); // 64s clamped to 60s
    expect(computeBusySkipBackoffMs(7, p)).toBe(60_000);
  });

  it("clamps to the ceiling without overflow for very large counts", () => {
    expect(computeBusySkipBackoffMs(1_000, params(60_000))).toBe(60_000); // factor**1000 -> Infinity, clamped
    expect(computeBusySkipBackoffMs(-5, params(60_000))).toBe(1_000); // negative guarded to factor^0
  });

  it("honors tunable baseMs and factor", () => {
    expect(computeBusySkipBackoffMs(0, { baseMs: 500, ceilingMs: 60_000, factor: 3 })).toBe(500);
    expect(computeBusySkipBackoffMs(1, { baseMs: 500, ceilingMs: 60_000, factor: 3 })).toBe(1_500);
    expect(computeBusySkipBackoffMs(2, { baseMs: 500, ceilingMs: 60_000, factor: 3 })).toBe(4_500);
  });
});

describe("classifyContinuationWorkReason", () => {
  it("keeps wait-shaped continuation reasons observable without text-driving dispatch", () => {
    expect(classifyContinuationWorkReason("Clearing wake cascade. Yielding and standing by.")).toBe(
      "wait-shaped",
    );
    expect(classifyContinuationWorkReason("Follow up with the package summary.")).toBe(
      "follow-up-work",
    );
    expect(classifyContinuationWorkReason(undefined)).toBe("unknown");
  });
});

function work(
  partial: Partial<{
    hop: number;
    electedAt: number;
    dueAt: number;
    status: "queued" | "running";
  }> = {},
): Parameters<typeof partitionSupersededWork>[0][number] {
  return {
    sessionKey: "agent:main:s",
    hop: partial.hop ?? 1,
    delayMs: 1_000,
    electedAt: partial.electedAt ?? 1_000,
    dueAt: partial.dueAt ?? 2_000,
    maxChainLength: 8,
    status: partial.status ?? "queued",
    flowId: `f-${partial.hop ?? 1}`,
    expectedRevision: 0,
  };
}

describe("partitionSupersededWork (drain-superseded)", () => {
  const GRACE = 120_000;
  const NOW = 1_000_000;

  it("passes a single matured work through untouched", () => {
    const works = [work({ hop: 1, electedAt: 1, dueAt: 1 })];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive).toHaveLength(1);
    expect(superseded).toHaveLength(0);
  });

  it("never collapses when grace is non-positive (guard disabled)", () => {
    const works = [
      work({ hop: 1, electedAt: 1, dueAt: 1 }),
      work({ hop: 2, electedAt: 2, dueAt: 2 }),
      work({ hop: 3, electedAt: 3, dueAt: 3 }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, 0, NOW);
    expect(drive).toHaveLength(3);
    expect(superseded).toHaveLength(0);
  });

  it("folds stale older siblings into the newest-elected member (backlog)", () => {
    // All three matured long ago (overdue >> grace): a genuine stale pile.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000 }),
      work({ hop: 2, electedAt: 200, dueAt: NOW - 400_000 }),
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000 }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop)).toEqual([3]); // newest-elected drives
    expect(superseded.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
  });

  it("preserves a close burst that is not yet stale (within grace)", () => {
    // Three matured just now, none overdue past grace: distinct close burst.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 10 }),
      work({ hop: 2, electedAt: 200, dueAt: NOW - 5 }),
      work({ hop: 3, electedAt: 300, dueAt: NOW }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive).toHaveLength(3);
    expect(superseded).toHaveLength(0);
  });

  it("keeps the newest even if it is itself overdue, folds only stale older", () => {
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000 }), // stale older
      work({ hop: 2, electedAt: 200, dueAt: NOW - 1_000 }), // recent, not stale
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000 }), // newest, stale-but-newest
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    // newest (hop 3) always drives; hop 2 within grace drives; hop 1 stale folds.
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([2, 3]);
    expect(superseded.map((w) => w.hop)).toEqual([1]);
  });

  it("tie-breaks same-millisecond electedAt by hop — keeps the highest-hop newest intent", () => {
    // Synchronous batch enqueue can stamp identical electedAt; the newest intent
    // is the highest hop, NOT the first array-order row. consumePendingWork
    // sorts createdAt asc, so the stale older sibling appears first.
    const works = [
      work({ hop: 1, electedAt: 5_000, dueAt: NOW - 500_000 }), // same ms, oldest hop, stale
      work({ hop: 2, electedAt: 5_000, dueAt: NOW - 400_000 }), // same ms, middle hop, stale
      work({ hop: 3, electedAt: 5_000, dueAt: NOW - 300_000 }), // same ms, NEWEST hop
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    // The highest-hop (3) is the kept newest — NOT the first array row (hop 1).
    expect(drive.map((w) => w.hop)).toEqual([3]);
    expect(superseded.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
  });

  it("never supersedes a recovered running member even when stale and not newest", () => {
    // A recovered `running` turn is actively executing (it may be observing
    // requests-in-flight). It must drive, never fold, even though it is overdue
    // past grace and a newer queued election exists. RED before the write-guard:
    // the stale, non-newest running member was classified `superseded`.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "running" }), // stale running, oldest
      work({ hop: 2, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued election
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(superseded).toHaveLength(0);
  });

  it("still folds a stale queued member into a newer election (Guard 2 intact)", () => {
    // The only supersede-eligible member is `queued`; the behavior is
    // unchanged for genuine queued backlog.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "queued" }), // stale queued backlog
      work({ hop: 2, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued election
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop)).toEqual([2]);
    expect(superseded.map((w) => w.hop)).toEqual([1]);
  });

  it("mixed batch: stale running drives, stale queued folds, newest queued drives", () => {
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "running" }), // stale running → drives
      work({ hop: 2, electedAt: 200, dueAt: NOW - 400_000, status: "queued" }), // stale queued → folds
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued → drives
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 3]);
    expect(superseded.map((w) => w.hop)).toEqual([2]);
  });
});

describe("maxPendingWork cap (Guard 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    resetWorkDispatchCustodyHooks();
    workDispatchCustodyHooks.onApplied = (update) => {
      const transition = describeWorkTransition(update);
      if (transition) {
        workTransitionEvents.push(transition);
      }
    };
    resetContinuationWorkDispatchForTests();
  });
  afterEach(() => {
    resetContinuationWorkDispatchForTests();
    vi.useRealTimers();
  });

  const sessionKey = "agent:main:flood";
  const baseChain = { currentChainCount: 0, chainStartedAt: 1_000_000, accumulatedChainTokens: 0 };

  it("rejects a new election once pendingWorkCount is at maxPendingWork", async () => {
    const capped = {
      ...config,
      maxPendingWork: 2,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Pre-fill the store to the cap (2 queued flows).
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });

    const result = await scheduleContinuationWork({
      sessionKey,
      chainState: baseChain,
      request: { delaySeconds: 1, reason: "over the pending cap" },
      config: capped,
    });

    expect(result.scheduled).toBe(false);
    expect(result.capped).toBe(true);
  });

  it("batch ends early on pending-cap but preserves earlier scheduled elections (partial-success)", async () => {
    const capped = {
      ...config,
      maxPendingWork: 3,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Start empty; a 5-election batch should schedule 3, then hit the cap.
    const result = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: baseChain,
      requests: [
        { delaySeconds: 1, reason: "a" },
        { delaySeconds: 1, reason: "b" },
        { delaySeconds: 1, reason: "c" },
        { delaySeconds: 1, reason: "d" },
        { delaySeconds: 1, reason: "e" },
      ],
      config: capped,
    });

    expect(result.scheduledCount).toBe(3);
    expect(result.cappedCount).toBe(2);
    expect(result.capped).toBe(true);
    // The 3 earlier elections stayed durably enqueued (not silently dropped).
    const queued = (await custodyRecords()).filter((f) => f.ownerSessionKey === sessionKey);
    expect(queued).toHaveLength(3);
  });

  it("does NOT count the active driving (running) wake against the cap — serial maxPendingWork:1 still schedules its successor", async () => {
    const capOne = {
      ...config,
      maxPendingWork: 1,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Simulate the in-flight driver: one continuation-work flow currently
    // `running` (its turn is being driven; markPendingWorkTurnGranted hasn't run
    // yet). A serial chain at maxPendingWork:1 must still schedule the successor
    // — the running driver is NOT a pending future wake.
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });
    const driver = (await custodyRecords()).find((f) => f.ownerSessionKey === sessionKey);
    if (driver) {
      await writeRecordForTest(driver.recordId, {
        status: "running",
      });
    }

    const result = await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 1, chainStartedAt: 1_000_000, accumulatedChainTokens: 0 },
      request: { delaySeconds: 1, reason: "serial successor under cap 1" },
      config: capOne,
    });

    // Pre-fix this rejected (running driver counted → pending 1 >= cap 1).
    // Post-fix the running driver is excluded, so the successor schedules.
    expect(result.scheduled).toBe(true);
    expect(result.capped).toBe(false);
  });

  it("preserves prior parked work when cross-turn coalescing is disabled", async () => {
    const coalesceSessionKey = "agent:main:coalesce-disabled";
    activeSessions.add(coalesceSessionKey);
    const cappedConfig = { ...config, maxPendingWork: 2 };
    await scheduleContinuationWorkBatch({
      sessionKey: coalesceSessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      requests: [{ reason: "prior parked work", delaySeconds: 0 }],
      config: cappedConfig,
    });
    await scheduleContinuationWorkBatch({
      sessionKey: coalesceSessionKey,
      chainState: { currentChainCount: 1, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      requests: [{ reason: "independent parked work", delaySeconds: 0 }],
      config: cappedConfig,
      coalescePriorParkedWork: false,
    });

    expect((await custodyRecords()).filter((flow) => flow.status === "queued")).toHaveLength(2);
  });
});
