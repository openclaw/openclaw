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
let [gatewayDraining, drainAfterReply] = [false, false];
let replyError: Error | undefined, commandLaneIdleError: Error | undefined;
let replyPayloadOverride: unknown;
let activeQueueMode: "delivered" | "queued-without-proof" | "rejected" = "delivered";
let [activeQueueHandleAvailable, continuationEnabledForTest] = [true, true];
const mockSessionStore: Record<string, unknown> = {};
const loadSessionEntryMock = vi.fn();
let mockStorePath = "test-store",
  observeSubordinateAdmission = false;
const observedSubordinateAdmissionClosed: boolean[] = [];
// test state: toggle continuation enablement (disabled-gate), capture the
// active diagnostic traceparent at reply time (traceparent re-entry), and force
// a revision race after the turn ran (failed durable delivered-mark).
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
  consumeSelectedSystemEventEntries: () => [],
  enqueueSystemEventRaw: (text: string, options: unknown) => {
    systemEvents.push({ text, options });
  },
  peekSystemEventEntries: () => [],
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
import { clearSessionResetRuntimeState } from "../reply/session-reset-cleanup.js";
import { updateContinuationRecords } from "./custody/custody-store.js";
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
import { cancelSessionContinuations, rearmKeptContinuations } from "./session-reset.js";
import type { ContinuationRuntimeConfig } from "./types.js";
import {
  describeWorkTransition,
  resetWorkDispatchCustodyHooks,
  settleWorkDispatchCustody,
  workDispatchCustodyHooks,
} from "./work-dispatch-flow-mock.test-support.js";
import {
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  clearContinuationWorkDispatch,
  computeBusySkipBackoffMs,
  dispatchPendingContinuationWork,
  partitionSupersededWork,
  recoverPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
} from "./work-dispatch.js";
import { captureContinuationWorkRecipientAuthority } from "./work-recipient-authority.js";
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

async function firstWorkRecord() {
  return (await listCustodyRecordsForTest({ kinds: ["work"] })).at(0);
}

async function bumpRecordRevision(recordId: string): Promise<void> {
  const record = await readCustodyRecordForTest(recordId);
  if (!record) {
    throw new Error(`expected custody record ${recordId}`);
  }
  const bumped = await updateContinuationRecords(
    [
      {
        recordId,
        ownerSessionKey: record.ownerSessionKey,
        expectedRevision: record.revision,
        patch: { updatedAt: record.updatedAt },
      },
    ],
    { now: record.updatedAt },
  );
  if (bumped.outcome !== "applied") {
    throw new Error(`expected concurrent revision bump to commit: ${bumped.outcome}`);
  }
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
  os,
  path,
  resolveReplyRunIdle,
  resolveCommandLaneIdle,
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
  scheduleContinuationWorkBatch,
  hasLiveOrRecentlyDispatchedContinuationWork,
  addSubagentRun,
  flushTimers,
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
 * Fake timers owned by continuation dispatch. Every custody command re-arms
 * the shared-state worker's one idle-retirement timer, and every recipient-
 * authority read or capture the agent database owner's; neither is dispatch
 * state, so the count is taken right after one of each and excludes both.
 */
async function dispatchTimerCount(): Promise<number> {
  await listCustodyRecordsForTest();
  await captureContinuationWorkRecipientAuthority("agent:main:dispatch-timer-count");
  return vi.getTimerCount() - 2;
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
    mockStorePath = "test-store";
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

  it("returns the committed revision without mutating delivered-work input", async () => {
    const work = await claimMaturedWork("agent:main:immutable-delivered");
    const input = structuredClone(work);

    const result = await markPendingWorkDelivered(work);

    expect(result).toEqual({
      applied: true,
      work: {
        ...input,
        expectedRevision: (input.expectedRevision ?? 0) + 1,
        deliveredAt: Date.now(),
        disposition: "granted",
        succeeded: { point: "optimal", durability: "durable" },
      },
    });
    expect(work).toEqual(input);
    const record = await readCustodyRecordForTest(work.flowId ?? "");
    expect(record?.revision).toBe((input.expectedRevision ?? 0) + 1);
    expect(record && custodyStateForTest(record)).toMatchObject({
      deliveredAt: Date.now(),
      disposition: "granted",
      succeeded: { point: "optimal", durability: "durable" },
    });
  });

  it("returns the committed revision without mutating fold-delivered input", async () => {
    const work = await claimMaturedWork("agent:main:immutable-fold-delivered");
    const input = structuredClone(work);

    const result = await markPendingWorkFoldDelivered(work, {
      foldedAt: Date.now(),
      overdueByMs: 250,
    });

    expect(result).toEqual({
      applied: true,
      work: {
        ...input,
        expectedRevision: (input.expectedRevision ?? 0) + 1,
        disposition: "folded-active",
        foldedAt: Date.now(),
        overdueByMs: 250,
        busySkipCount: 0,
        succeeded: { point: "optimal", durability: "durable" },
      },
    });
    expect(work).toEqual(input);
    const record = await readCustodyRecordForTest(work.flowId ?? "");
    expect(record?.revision).toBe((input.expectedRevision ?? 0) + 1);
    expect(record && custodyStateForTest(record)).toMatchObject({
      disposition: "folded-active",
      foldedAt: Date.now(),
      overdueByMs: 250,
      busySkipCount: 0,
      succeeded: { point: "optimal", durability: "durable" },
    });
  });

  it.each([
    {
      name: "delivered",
      apply: (work: Awaited<ReturnType<typeof claimMaturedWork>>) => markPendingWorkDelivered(work),
    },
    {
      name: "fold-delivered",
      apply: (work: Awaited<ReturnType<typeof claimMaturedWork>>) =>
        markPendingWorkFoldDelivered(work, { foldedAt: Date.now(), overdueByMs: 250 }),
    },
  ])("returns the original $name work on a CAS conflict", async ({ apply }) => {
    const work = await claimMaturedWork("agent:main:immutable-cas-conflict");
    const input = structuredClone(work);
    const flow = await readCustodyRecordForTest(work.flowId ?? "");
    if (!flow) {
      throw new Error("expected claimed continuation work record");
    }
    const stateBeforeConflict = flow.stateJson;
    // A concurrent writer commits between the claim and the delivered mark.
    await bumpRecordRevision(flow.recordId);

    const result = await apply(work);

    expect(result).toEqual({ applied: false, work });
    expect(work).toEqual(input);
    const after = await readCustodyRecordForTest(flow.recordId);
    expect(after?.revision).toBe(flow.revision + 1);
    expect(after?.stateJson).toBe(stateBeforeConflict);
  });

  it("fences a claimed work turn when reset lands before final admission", async () => {
    const sessionKey = "agent:main:reset-before-work-admission";
    mockSessionStore[sessionKey] = {
      sessionId: "reset-before-work-admission-session",
      lifecycleRevision: "reset-before-work-admission-revision",
    };
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "must not run after reset",
    });
    // The reset lands at the admission session read: after the claim commits
    // and before the final custody fence and the provider call.
    let reset: Promise<void> | undefined;
    let claimedStatusAtReset: Promise<string | undefined> | undefined;
    let providerCalledAtReset: boolean | undefined;
    const defaultSessionRead = loadSessionEntryMock.getMockImplementation();
    loadSessionEntryMock.mockImplementationOnce((scope: { sessionKey: string }) => {
      providerCalledAtReset = getReplyFromConfigMock.mock.calls.length > 0;
      claimedStatusAtReset = firstWorkRecord().then((record) => record?.status);
      reset = cancelSessionContinuations(sessionKey, () => {});
      clearContinuationWorkDispatch(sessionKey);
      return defaultSessionRead?.(scope);
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });
    await reset;

    expect(await claimedStatusAtReset).toBe("running");
    expect(providerCalledAtReset).toBe(false);
    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(turnGrants).toStrictEqual([]);
    expect((await firstWorkRecord())?.status).toBe("cancelled");
    expect(await consumePendingWork(sessionKey, { includeRunning: true })).toStrictEqual([]);
  });

  // #1271: a reset re-arms the wakes it kept, and only those; a disabled feature or an empty
  // queue must not start a recheck loop for the session.
  it("a reset re-arm arms nothing when continuation is disabled or no wake is queued", async () => {
    const sessionKey = "agent:main:rearm-after-reset";
    mockSessionStore[sessionKey] = { sessionId: "rearm-after-reset-session" };
    const rearm = async () => {
      await rearmKeptContinuations({ sessionKey, storePath: mockStorePath });
      await flushAsyncWork();
    };
    const before = await dispatchTimerCount();
    await rearm();
    expect(await dispatchTimerCount()).toBe(before);

    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 60_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 60_000,
      maxChainLength: 8,
    });
    continuationEnabledForTest = false;
    await rearm();
    expect(await dispatchTimerCount()).toBe(before);

    continuationEnabledForTest = true;
    await rearm();
    expect(await dispatchTimerCount()).toBe(before + 1);
  });

  it("requeues claimed work when an implicit rollover changes lifecycle before admission", async () => {
    const sessionKey = "agent:main:rollover-before-work-admission";
    const previousEntry = {
      sessionId: "rollover-before-work-admission-session",
      lifecycleRevision: "previous-lifecycle-revision",
    };
    const successorEntry = {
      sessionId: previousEntry.sessionId,
      lifecycleRevision: "successor-lifecycle-revision",
    };
    let sessionReadCount = 0;
    loadSessionEntryMock.mockImplementation(() => {
      sessionReadCount += 1;
      return sessionReadCount === 1 ? previousEntry : successorEntry;
    });
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "continue after implicit rollover",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect((await firstWorkRecord())?.status).toBe("queued");
  });

  // A head swap keeps queued work (#1271); delete still terminalizes it through this loop.
  it("keeps scheduled timers and idle ownership when durable delete cancellation fails", async () => {
    const sessionKey = "agent:main:reset-persist-failure";
    mockSessionStore[sessionKey] = {
      sessionId: "reset-persist-failure-session",
      lifecycleRevision: "reset-persist-failure-revision",
    };
    activeSessions.add(sessionKey);
    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
      },
      request: { delaySeconds: 1, reason: "survive failed reset" },
      config,
    });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    const timersBeforeReset = vi.getTimerCount();
    workDispatchCustodyHooks.refuseUpdatesWith = "persist_failed";

    await expect(
      clearSessionResetRuntimeState([sessionKey], {
        agentId: "main",
        sessionKey,
        assertCurrent: () => {},
        reason: "delete",
        activeReplySessionId: "reset-persist-failure-session",
      }),
    ).rejects.toThrow("could not cancel continuation record");

    expect(replyIdleWaiters.has(sessionKey)).toBe(true);
    expect(vi.getTimerCount()).toBe(timersBeforeReset);
    expect((await firstWorkRecord())?.status).toBe("queued");

    delete workDispatchCustodyHooks.refuseUpdatesWith;
    await clearSessionResetRuntimeState([sessionKey], {
      agentId: "main",
      sessionKey,
      assertCurrent: () => {},
      reason: "delete",
      activeReplySessionId: "reset-persist-failure-session",
    });
    await flushAsyncWork();

    expect(replyIdleWaiters.has(sessionKey)).toBe(false);
    expect(vi.getTimerCount()).toBeLessThan(timersBeforeReset);
    expect((await firstWorkRecord())?.status).toBe("cancelled");
  });

  it("completes delete cancellation and transient cleanup after revision conflicts", async () => {
    const sessionKey = "agent:main:reset-revision-conflict";
    const sessionId = "reset-revision-conflict-session";
    mockSessionStore[sessionKey] = { sessionId };
    activeSessions.add(sessionKey);
    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { delaySeconds: 1, reason: "cancel after revision conflict" },
      config,
    });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    const timersBeforeReset = vi.getTimerCount();
    workDispatchCustodyHooks.revisionConflictsRemaining = 2;

    await clearSessionResetRuntimeState([sessionKey], {
      agentId: "main",
      sessionKey,
      assertCurrent: () => {},
      reason: "delete",
      activeReplySessionId: sessionId,
    });
    await flushAsyncWork();

    expect(workDispatchCustodyHooks.revisionConflictsRemaining).toBe(0);
    expect((await firstWorkRecord())?.status).toBe("cancelled");
    expect(replyIdleWaiters.has(sessionKey)).toBe(false);
    expect(vi.getTimerCount()).toBeLessThan(timersBeforeReset);
  });

  it("keeps one reply-run registry identity across election, idle retry, and execution", async () => {
    const sessionKey = "agent:main:registry-singleton";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    const immediateConfig = {
      ...config,
      defaultDelayMs: 0,
      minDelayMs: 0,
    } satisfies ContinuationRuntimeConfig;

    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
      },
      request: { delaySeconds: 0, reason: "singleton registry proof" },
      config: immediateConfig,
    });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    expect(replyRegistryReceivers.size).toBe(1);

    // Drive the persisted idle-retry row directly after the active run ends.
    // This keeps the identity proof deterministic even when the execution
    // owner's first dynamic provider/session imports are cold on CI.
    activeSessions.delete(sessionKey);
    const result = await dispatchPendingContinuationWork({
      sessionKey,
      includeIdleRetry: true,
    });

    expect(replyRegistryReceivers.size).toBe(1);
    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(1);
  });

  it("keeps registry memoization singular and timer/controller state lifecycle-owned", () => {
    const canonicalSource = fs.readFileSync(new URL("./work-dispatch.ts", import.meta.url), "utf8");
    const executionUrl = new URL("./work-dispatch-execution.ts", import.meta.url);
    const executionSource = fs.existsSync(executionUrl)
      ? fs.readFileSync(executionUrl, "utf8")
      : "";
    const combinedSource = `${canonicalSource}\n${executionSource}`;

    expect(combinedSource.match(/let continuationSessionRunsPromise/g)).toHaveLength(1);
    expect(
      combinedSource.match(
        /continuationSessionRunsPromise \?\?= Promise\.all\(\[\s*import\("\.\.\/\.\.\/sessions\/session-controller\.queries\.js"\),\s*import\("\.\.\/\.\.\/sessions\/session-controller\.js"\),?\s*\]\)/g,
      ),
    ).toHaveLength(1);
    expect(canonicalSource).toMatch(/const workTimers = new Map/);
    expect(canonicalSource).toMatch(/const idleRetryFailureTimers = new Map/);
    expect(canonicalSource).toMatch(/const idleRetryControllers = new Map/);
    expect(executionSource).not.toMatch(
      /const (?:workTimers|idleRetryFailureTimers|idleRetryControllers) =/,
    );
    expect(executionSource).not.toMatch(/from "\.\/work-dispatch\.js"/);
    expect(executionSource).not.toMatch(
      /\b(?:armWorkTimer|armNextWorkTimer|armIdleRetryFailureTimer|registerIdleRetry)\s*\(/,
    );
    expect(canonicalSource).not.toMatch(
      /\b(?:markPendingWorkDelivered|markPendingWorkFoldDelivered|markPendingWorkTurnGranted|markPendingWorkFolded|markPendingWorkFailed|markPendingWorkReaped)\s*\(/,
    );
    expect(executionSource).toMatch(/export type ContinuationWorkExecutionDirective = Readonly</);
    expect(canonicalSource).toMatch(/applyExecutionDirective\(directive\)/);
  });

  it("commits provider delivery before finishing the claimed row", async () => {
    const sessionKey = "agent:main:provider-finish-order";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "provider finish ordering",
    });

    await dispatchPendingContinuationWork({ sessionKey });

    expect(workTransitionEvents).toEqual([
      "provider-called",
      "delivered-mark-committed",
      "flow-finished:Same-session continuation turn granted",
    ]);
  });

  it("commits an active-turn transcript and fold delivery before finishing the row", async () => {
    const sessionKey = "agent:main:fold-finish-order";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now() - 1,
      anchorFinalizedAt: Date.now() - 1,
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "fold finish ordering",
    });

    await dispatchPendingContinuationWork({ sessionKey });

    expect(workTransitionEvents).toEqual([
      "fold-transcript-committed",
      "fold-delivered-mark-committed",
      "flow-finished:folded-into-active-turn: matured while a later turn was active",
    ]);
  });

  it("reset aborts lifecycle-owned idle waiters and clears every dispatch timer", async () => {
    const replySessionKey = "agent:main:reset-reply-idle";
    const laneSessionKey = "agent:main:reset-lane-idle";
    mockSessionStore[replySessionKey] = { sessionKey: replySessionKey };
    mockSessionStore[laneSessionKey] = { sessionKey: laneSessionKey };
    activeSessions.add(replySessionKey);
    mainQueueSize = 1;
    for (const sessionKey of [replySessionKey, laneSessionKey]) {
      await enqueuePendingWork({
        sessionKey,
        hop: 1,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        reason: "reset cleanup proof",
      });
      await dispatchPendingContinuationWork({ sessionKey });
    }
    await waitForMockWaiter(replyIdleWaiters, replySessionKey);
    await waitForMockWaiter(laneIdleWaiters, "main");
    expect(await dispatchTimerCount()).toBeGreaterThan(0);

    resetContinuationWorkDispatchForTests();
    await flushAsyncWork();

    expect(replyIdleWaiters.has(replySessionKey)).toBe(false);
    expect(laneIdleWaiters.has("main")).toBe(false);
    expect(await dispatchTimerCount()).toBe(0);
  });

  it("requeues without mutating its claimed work input and clears retry-only state", async () => {
    const sessionKey = "agent:main:immutable-requeue";
    const enqueued = await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      recoveryDueAt: Date.now(),
      maxChainLength: 8,
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "wait-shaped",
        armedAt: Date.now(),
      },
    });
    if (!enqueued) {
      throw new Error("expected continuation work enqueue");
    }
    const [work] = await consumePendingWork(sessionKey, { includeIdleRetry: true });
    if (!work) {
      throw new Error("expected continuation work claim");
    }
    const input = structuredClone(work);
    const nextDueAt = Date.now() + 5_000;

    expect(
      await requeuePendingWork(work, {
        dueAt: nextDueAt,
        summary: "immutable requeue characterization",
        busySkipCount: 2,
      }),
    ).toBe(true);

    expect(work).toEqual(input);
    const flow = await readCustodyRecordForTest(work.flowId ?? "");
    expect(flow).toMatchObject({
      status: "queued",
      revision: (input.expectedRevision ?? 0) + 1,
    });
    const state = flow ? custodyStateForTest(flow) : {};
    expect(state).toMatchObject({ dueAt: nextDueAt, busySkipCount: 2 });
    expect(state).not.toMatchObject({ idleRetry: expect.anything() });
    expect(state).not.toMatchObject({ recoveryDueAt: expect.anything() });
  });

  it("honors hot-disabled continuation before consuming or driving queued work", async () => {
    const sessionKey = "agent:main:disabled-gate";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "disabled gate",
    });
    await advanceTimers(1_000);

    // Operator hot-disables continuation after the wake was armed.
    continuationEnabledForTest = false;
    const result = await dispatchPendingContinuationWork({ sessionKey });
    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(await dispatchTimerCount()).toBeGreaterThan(0);

    // The queued row was not consumed/mutated, and the disabled callback left a
    // recheck timer so hot re-enable recovers it without waiting for startup or
    // unrelated traffic.
    expect(await dispatchTimerCount()).toBeGreaterThan(0);
    continuationEnabledForTest = true;
    await dispatchPendingContinuationWork({
      sessionKey,
      includeIdleRetry: true,
    });
    await vi.waitFor(() => {
      expect(turnGrants).toHaveLength(1);
    });
  });
});
