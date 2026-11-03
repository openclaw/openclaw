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
const observedDetachedAuthority: Array<{
  direct: boolean;
  requestClient: boolean;
  resolver: boolean;
}> = [];
const observedOperatorScopes: string[][] = [];
// test state: toggle continuation enablement (disabled-gate), capture the
// active diagnostic traceparent at reply time (traceparent re-entry), and force
// a revision race after the turn ran (failed durable delivered-mark).
let continuationEnabledForTest = true;
const capturedReplyTraceparents: Array<string | undefined> = [];
let bumpWorkRevisionOnReply = false;
let observeReplyGeneration: (() => void) | undefined;
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
    observeReplyGeneration?.();
    if (observedDetachedAuthority.length === 1) {
      const [{ readOperatorToolGatewayAuthority }, { getPluginRuntimeGatewayRequestScope }] =
        await Promise.all([
          import("../../gateway/operator-tool-gateway-authority.js"),
          import("../../plugins/runtime/gateway-request-scope.js"),
        ]);
      const scope = getPluginRuntimeGatewayRequestScope();
      observedDetachedAuthority[0] = {
        direct: readOperatorToolGatewayAuthority() !== undefined,
        requestClient: scope?.client !== undefined,
        resolver: scope?.resolveGatewayContext !== undefined,
      };
    }
    const { readOperatorToolGatewayAuthority } =
      await import("../../gateway/operator-tool-gateway-authority.js");
    observedOperatorScopes.push([...(readOperatorToolGatewayAuthority()?.scopes ?? [])]);
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
import {
  createPluginGenerationReload,
  CURRENT_PLUGIN_GENERATION,
  inheritArmingContextInFakeTimers,
  type ObservedPluginGeneration,
} from "./plugin-generation-reload.test-support.js";
import type { ContinuationRuntimeConfig } from "./types.js";
import { runDetachedAuthorityFossil } from "./work-dispatch-authority.test-support.js";
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
  hasLiveContinuationCustody,
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
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
  addSubagentRun,
  config,
  flushTimers,
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
    observedDetachedAuthority.length = 0;
    observedOperatorScopes.length = 0;
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

  it("uses the busy-skip ceiling as a slow hedge while idle events own normal retry", async () => {
    const sessionKey = "agent:main:busy-slow-hedge";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "storm",
    });

    for (let i = 0; i < 4; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      // Drop the just-armed idle listener/timer so each re-consume is deterministic.
      resetContinuationWorkDispatchForTests();
      const flow = (await custodyRecords())[0];
      expect(flow?.status).toBe("queued");
      const state = flow?.stateJson as {
        dueAt: number;
        busySkipCount?: number;
        retryCount?: number;
      };
      expect(state.dueAt - Date.now()).toBe(60_000);
      expect(state.busySkipCount).toBe(i + 1);
      expect(state.retryCount).toBeUndefined(); // busy-skip never penalizes
      await advanceTimers(60_000);
    }

    expect(turnGrants).toHaveLength(0); // never driven while busy, never dropped
    expect(systemEvents).toEqual([]); // never failed
  });

  it("never increments retryCount or drops the flow across many busy-skips (rate-cap-forever, never-penalize)", async () => {
    const sessionKey = "agent:main:busy-forever";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "forever busy",
    });

    // Far more skips than MAX_TRANSIENT_ERROR_RETRY_COUNT (8): a busy-defer must
    // never approach the fail-bound, never fail, never drop.
    for (let i = 0; i < 20; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      resetContinuationWorkDispatchForTests();
      await advanceTimers(60_000); // mature past the ceiling each loop
    }

    const flow = (await custodyRecords())[0];
    expect(flow?.status).toBe("queued"); // never failed/dropped — still deliverable
    const state = flow?.stateJson as { busySkipCount?: number; retryCount?: number };
    expect(state.busySkipCount).toBe(20);
    expect(state.retryCount).toBeUndefined();
    expect(turnGrants).toHaveLength(0);
    expect(systemEvents).toEqual([]); // no failure warning ever enqueued
  });

  it("resets busySkipCount to 0 and delivers once a busy-deferred flow finally drives (Pillar-0 +)", async () => {
    const sessionKey = "agent:main:busy-then-drive";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "deferred then drives",
    });

    for (let i = 0; i < 3; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      resetContinuationWorkDispatchForTests();
      await advanceTimers(60_000);
    }
    const deferredState = (await custodyRecords())[0]?.stateJson as { busySkipCount?: number };
    expect(deferredState.busySkipCount).toBe(3);

    // Once the session quiets, the deferred flow delivers without being dropped, and the
    // granted record clears the backoff counter (rate-cap, never permanent).
    activeSessions.clear();
    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    const flow = (await custodyRecords())[0];
    expect(flow?.status).toBe("succeeded");
    const state = flow?.stateJson as { busySkipCount?: number; turnGrantedAt?: number };
    expect(state.busySkipCount).toBe(0);
    expect(state.turnGrantedAt).toBeGreaterThan(0);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("deferred then drives") }),
      }),
    ]);
  });

  it("does not re-consume a cancel-requested continuation work flow (dedup harden, Pillar-0)", async () => {
    const sessionKey = "agent:main:cancel-requested";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "cancel requested",
    });
    const flow = (await custodyRecords())[0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    // User requested cancel; the maintenance reaper has not yet finalized it.
    await writeRecordForTest(flow.recordId, {
      cancelRequestedAt: Date.now(),
    });

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now(),
    });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    // Left untouched (still queued) for the reaper to finalize — not driven.
    expect((await custodyRecords())[0]?.status).toBe("queued");
  });

  it("does not re-consume a terminal (succeeded) continuation work flow", async () => {
    const sessionKey = "agent:main:already-succeeded";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "already succeeded",
    });
    const flow = (await custodyRecords())[0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    await writeRecordForTest(flow.recordId, {
      status: "succeeded",
      stateJson: JSON.stringify({
        ...(flow.stateJson as object),
        succeeded: { point: "optimal", durability: "durable" },
      }),
    });
    const before = await readCustodyRecordForTest(flow.recordId);
    if (!before) {
      throw new Error("expected succeeded continuation work record");
    }

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now(),
    });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    expect(await readCustodyRecordForTest(flow.recordId)).toEqual(before);
    expect(before).toMatchObject({ status: "succeeded", revision: flow.revision + 1 });
  });

  // Contract change (RFC §5.4.6): the synchronous guard reads the hot-path
  // projection, which counts every live record, so a delivered-marked record
  // left `running` reads as live (retention errs safe) until startup recovery
  // finalizes it. The authoritative async guard excludes it, matching the
  // consume guard, so cleanup never strands the child session.
  it("does not count a delivered-marked-but-still-running record as live custody (cleanup-guard matches the consume-guard)", async () => {
    // Crash in the markPendingWorkDelivered -> finish gap leaves the record
    // `status:running` with state `succeeded` set. The consume guards already
    // exclude it from re-delivery; hasLiveContinuationCustody must match, or
    // deleteSubagentSessionForCleanup / the registry sweep treat the delivered
    // record as live and strand its child session forever.
    const sessionKey = "agent:main:delivered-but-running";
    mockSessionStore[sessionKey] = { sessionKey };
    await enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "delivered but crashed before finishFlow",
    });
    const flow = (await custodyRecords())[0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    // delivered-marked, but finishFlow never ran (process died in the gap):
    await writeRecordForTest(flow.recordId, {
      status: "running",
      stateJson: JSON.stringify({
        ...(flow.stateJson as Record<string, unknown>),
        succeeded: { point: "optimal", durability: "durable" },
      }),
    });

    expect(await hasLiveContinuationCustody(sessionKey)).toBe(false);
    // The projection answer stays conservative until recovery finalizes it.
    expect(hasLiveOrRecentlyDispatchedContinuationWork(sessionKey)).toBe(true);
    await consumePendingWork(sessionKey, { includeRunning: true });
    expect((await readCustodyRecordForTest(flow.recordId))?.status).toBe("succeeded");
    expect(hasLiveOrRecentlyDispatchedContinuationWork(sessionKey)).toBe(false);
  });
  it("does not inherit settled request authority into a detached wake", async () => {
    await runDetachedAuthorityFossil({ mockSessionStore, observedDetachedAuthority, turnGrants });
  });

  it.each([
    ["opted-in", true],
    ["non-opted-in", false],
  ])(
    "wakes delayed work on the current plugin generation after a %s reload",
    async (_reload, generationOverlap) => {
      const sessionKey = "agent:main:generation-reload-wake";
      mockSessionStore[sessionKey] = { sessionKey };
      const timers = inheritArmingContextInFakeTimers();
      const reload = createPluginGenerationReload(generationOverlap);
      const observed: ObservedPluginGeneration[] = [];
      observeReplyGeneration = () => observed.push(reload.observe());
      try {
        await reload.armInPredecessorTurn(() =>
          scheduleContinuationWork({
            sessionKey,
            chainState: {
              currentChainCount: 0,
              chainStartedAt: Date.now(),
              accumulatedChainTokens: 0,
            },
            request: { reason: "generation reload", delaySeconds: 5 },
            config,
          }),
        );
        await reload.reload();
        await advanceTimers(5_000);
        expect(observed).toEqual([CURRENT_PLUGIN_GENERATION]);
        expect(turnGrants).toHaveLength(1);
      } finally {
        observeReplyGeneration = undefined;
        timers.mockRestore();
        await reload.dispose();
      }
    },
  );

  it("wakes delayed operator work on the current plugin generation after a reload", async () => {
    const sessionKey = "agent:main:generation-reload-operator-wake";
    mockSessionStore[sessionKey] = { sessionKey };
    const { getPluginRuntimeGatewayRequestScope, withPluginRuntimeGatewayRequestScope } =
      await import("../../plugins/runtime/gateway-request-scope.js");
    const timers = inheritArmingContextInFakeTimers();
    const reload = createPluginGenerationReload(true);
    const observed: ObservedPluginGeneration[] = [];
    observeReplyGeneration = () => observed.push(reload.observe());
    try {
      await reload.armInPredecessorTurn(() => {
        // As the in-process operator authority does, retain the arming request's whole scope.
        const continuationScope = {
          isWebchatConnect: () => false,
          ...getPluginRuntimeGatewayRequestScope(),
        };
        const operatorContinuation = {
          operatorAuthority: {},
          assertCurrent: vi.fn(),
          release: vi.fn(),
          run: <T>(run: () => T): T => withPluginRuntimeGatewayRequestScope(continuationScope, run),
        };
        return scheduleContinuationWork({
          sessionKey,
          chainState: {
            currentChainCount: 0,
            chainStartedAt: Date.now(),
            accumulatedChainTokens: 0,
          },
          request: { reason: "operator generation reload", delaySeconds: 5, operatorContinuation },
          config,
        });
      });
      await reload.reload();
      await advanceTimers(5_000);
      expect(observed).toEqual([CURRENT_PLUGIN_GENERATION]);
      expect(turnGrants).toHaveLength(1);
    } finally {
      observeReplyGeneration = undefined;
      timers.mockRestore();
      await reload.dispose();
    }
  });

  it("re-enters retained role limits for an accepted operator wake", async () => {
    const sessionKey = "agent:main:role-limited-wake";
    mockSessionStore[sessionKey] = { sessionKey };
    const { runWithOperatorToolGatewayAuthority } =
      await import("../../gateway/operator-tool-gateway-authority.js");
    const controller = new AbortController();
    const custody = {
      operatorAuthority: {},
      assertCurrent: () => controller.signal.throwIfAborted(),
      release: vi.fn(),
      run: <T>(run: () => T): T =>
        runWithOperatorToolGatewayAuthority(
          {
            scopes: ["operator.read"],
            signal: controller.signal,
            assertCurrent: () => controller.signal.throwIfAborted(),
          },
          run,
        ),
    };
    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { reason: "role-limited", delaySeconds: 0, operatorContinuation: custody },
      config: { ...config, minDelayMs: 0, defaultDelayMs: 0 },
    });
    expect((await custodyRecords(sessionKey))[0]?.stateJson).toMatchObject({
      operatorAuthorityRequired: true,
    });
    const result = await dispatchPendingContinuationWork({ sessionKey });
    expect(result.dispatched).toBe(1);
    expect(observedOperatorScopes).toEqual([["operator.read"]]);
    expect(custody.release).toHaveBeenCalledOnce();
  });

  it("refuses a revoked or lost retained operator source without running the model", async () => {
    const sessionKey = "agent:main:revoked-operator-wake";
    mockSessionStore[sessionKey] = { sessionKey };
    const controller = new AbortController();
    const custody = {
      operatorAuthority: {},
      assertCurrent: () => controller.signal.throwIfAborted(),
      release: vi.fn(),
      run: <T>(run: () => T): T => run(),
    };
    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { reason: "revoked", delaySeconds: 0, operatorContinuation: custody },
      config: { ...config, minDelayMs: 0, defaultDelayMs: 0 },
    });
    controller.abort(new Error("operator revoked"));
    const result = await dispatchPendingContinuationWork({ sessionKey });
    expect(result.failed).toBe(1);
    expect(turnGrants).toHaveLength(0);
    expect((await custodyRecords())[0]?.status).toBe("failed");
    expect(custody.release).toHaveBeenCalledOnce();
  });

  it("fails closed when durable operator work survives but volatile custody does not", async () => {
    const sessionKey = "agent:main:recovered-operator-wake";
    mockSessionStore[sessionKey] = { sessionKey };
    const custody = {
      operatorAuthority: {},
      assertCurrent: vi.fn(),
      release: vi.fn(),
      run: <T>(run: () => T): T => run(),
    };
    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { reason: "recover", delaySeconds: 0, operatorContinuation: custody },
      config: { ...config, minDelayMs: 0, defaultDelayMs: 0 },
    });
    resetContinuationWorkDispatchForTests();
    const result = await dispatchPendingContinuationWork({ sessionKey });
    expect(result.failed).toBe(1);
    expect(turnGrants).toHaveLength(0);
    expect((await custodyRecords(sessionKey))[0]?.status).toBe("failed");
    expect(custody.release).toHaveBeenCalledOnce();
  });
});
