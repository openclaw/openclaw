import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE } from "../../config/sessions/lifecycle.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  resetDiagnosticRunActivityForTest,
  RUN_STALE_TAKEOVER_MS,
} from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import {
  getTerminalSessionWorkAdmissionRelease,
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS } from "./reply-run-registry.contracts.js";
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";
import { admitTestReplyTurn, createSessionStore } from "./reply-turn-admission.test-support.js";

const releaseMocks = vi.hoisted(() => ({
  beforeRelease: vi.fn(async () => {}),
  schedule: vi.fn(),
}));
vi.mock(
  import("../../agents/main-session-recovery/main-session-recovery-store.js"),
  async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      releaseMainSessionRecoveryOwner: async (
        lease: Parameters<typeof actual.releaseMainSessionRecoveryOwner>[0],
      ) => {
        await releaseMocks.beforeRelease();
        return await actual.releaseMainSessionRecoveryOwner(lease);
      },
    };
  },
);
vi.mock(
  import("../../agents/main-session-recovery/main-session-recovery-owner-release.js"),
  async (importOriginal) => ({
    ...(await importOriginal()),
    scheduleMainSessionRecoveryPendingTarget: releaseMocks.schedule,
  }),
);

const sessionKey = "agent:main:telegram:topic:admission";
const sessionId = "original-session";
const scope = { sessionKey, sessionId };
const sourceKey = "agent:main:telegram:slash:source";
const activeRunSkipped = { status: "skipped", reason: "active-run" };
function admit(overrides: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {}) {
  return admitTestReplyTurn({ ...scope, ...overrides });
}
function admitStored(storePath: string, overrides: Parameters<typeof admit>[0] = {}) {
  return admit({ storePath, expectedSessionId: sessionId, ...overrides });
}
function adopt(
  storePath: string,
  reservation: ReturnType<typeof operation>,
  overrides: Parameters<typeof admit>[0] = {},
) {
  return admitStored(storePath, {
    sessionId: reservation.sessionId,
    waitForActive: false,
    adoptOperation: reservation,
    ...overrides,
  });
}
function observe<T>(promise: Promise<T>) {
  const pending = {
    settled: false,
    promise: promise.then((result) => {
      pending.settled = true;
      return result;
    }),
  };
  return pending;
}
function abortableAdmission(overrides: Parameters<typeof admit>[0]) {
  const controller = new AbortController();
  return Object.assign(observe(admit({ ...overrides, upstreamAbortSignal: controller.signal })), {
    abort: () => controller.abort(),
  });
}
function operation(overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {}) {
  return createReplyOperation({ ...scope, resetTriggered: false, ...overrides });
}
function owned(result: Awaited<ReturnType<typeof admit>>) {
  assert(result.status === "owned", "Expected reply ownership");
  return result.operation;
}
function store(state: Partial<SessionEntry> = {}) {
  return createSessionStore({ [sessionKey]: { sessionId, updatedAt: 100, ...state } });
}
function entry(storePath: string, key = sessionKey) {
  return loadSessionEntry({ storePath, sessionKey: key });
}
const interruptedEntry = {
  status: "interrupted",
  abortedLastRun: true,
  mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
} satisfies Partial<SessionEntry>;
const tombstoneEntry = {
  mainRestartRecovery: {
    cycleId: "cycle-1",
    revision: 4,
    chargedAttempts: 3,
    tombstone: {
      reason: "automatic recovery exhausted",
      recoveredSessionId: "dashboard-successor",
      recoveredSessionKey: "agent:main:dashboard:successor",
    },
  },
} satisfies Partial<SessionEntry>;
async function holdMutation(storePath: string, run: () => Promise<unknown> = async () => {}) {
  const started = createDeferred();
  const release = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation("patch", {
    scope: storePath,
    identities: [sessionKey, sessionId],
    run: async () => {
      started.resolve();
      await release.promise;
      await run();
    },
  });
  await started.promise;
  return async () => {
    release.resolve();
    await mutation;
  };
}
function holdRecoveryRelease() {
  const started = createDeferred();
  const release = createDeferred();
  releaseMocks.beforeRelease.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  return { started: started.promise, release: release.resolve };
}
async function expectRecoveryReleased(storePath: string, key = sessionKey) {
  await vi.waitFor(() =>
    expect(entry(storePath, key)?.mainRestartRecovery?.foregroundClaims).toBeUndefined(),
  );
}
function interrupt(storePath: string, run: () => Promise<void>, reason?: Error) {
  const target = { scope: storePath, identities: [sessionKey, sessionId] };
  return runExclusiveSessionLifecycleMutation("patch", {
    ...target,
    prepare: async () => {
      await interruptSessionWorkAdmissions({ ...target, reason });
    },
    run,
  });
}
afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  }
  testing.resetReplyRunRegistry();
  resetDiagnosticRunActivityForTest();
  releaseMocks.beforeRelease.mockClear();
  releaseMocks.schedule.mockClear();
});

it("rejects a reply when an archive commits before admission", async () => {
  const storePath = store();
  const release = await holdMutation(storePath, () =>
    replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 100, archivedAt: 100 }),
  );
  const admission = admit({ storePath });
  await release();
  await expect(admission).rejects.toMatchObject({
    name: "SessionWorkStartError",
    reason: "archived",
    retryable: false,
    message: `Session "${sessionKey}" is archived. Restore it before starting new work.`,
  });
});
it("rejects a reply when deletion commits before admission", async () => {
  const storePath = store();
  const release = await holdMutation(storePath, () =>
    deleteSessionEntryLifecycle({
      storePath,
      archiveTranscript: false,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    }),
  );
  const admission = admitStored(storePath);
  await release();
  await expect(admission).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
});
it("waits for recovery release before admitting a queued successor", async () => {
  const storePath = store(interruptedEntry);
  const owner = owned(await admitStored(storePath));
  const release = holdRecoveryRelease();
  owner.complete();
  await release.started;
  const successor = observe(admitStored(storePath, { kind: "queued_followup" }));
  await Promise.resolve();
  expect(successor.settled).toBe(false);
  await expect(admitStored(storePath, { kind: "heartbeat" })).resolves.toEqual(activeRunSkipped);
  release.release();
  owned(await successor.promise).complete();
  await expectRecoveryReleased(storePath);
});
it("preserves a source recovery identity after adopting a distinct target session", async () => {
  const storePath = createSessionStore({
    [sourceKey]: { sessionId, updatedAt: 100, ...interruptedEntry },
    [sessionKey]: { sessionId: "target-session", updatedAt: 100 },
  });
  const source = owned(await admitStored(storePath, { sessionKey: sourceKey }));
  const adopted = owned(await adopt(storePath, source, { expectedSessionId: "target-session" }));
  adopted.updateSessionId("target-session");
  expect(adopted).toBe(source);
  expect(adopted).toMatchObject({ key: sessionKey, sessionId: "target-session" });
  const targets = [sourceKey, sessionKey].map((key) => ({ scope: storePath, identities: [key] }));
  expect(targets.map(getTerminalSessionWorkAdmissionRelease)).toEqual([false, false]);
  adopted.freezeAbort();
  const terminalReleases = targets.map((target) => {
    const released = getTerminalSessionWorkAdmissionRelease(target);
    if (released === false) {
      throw new Error("Committed reply admission is still classified as live");
    }
    return released;
  });
  const release = holdRecoveryRelease();
  adopted.complete();
  await release.started;
  const successor = observe(admitStored(storePath, { sessionKey: sourceKey }));
  await Promise.resolve();
  expect(successor.settled).toBe(false);
  release.release();
  await Promise.all(terminalReleases);
  const next = owned(await successor.promise);
  expect(next.sessionId).toBe(sessionId);
  next.complete();
  await expectRecoveryReleased(storePath, sourceKey);
});
it("admits an explicit reset without reopening its restart tombstone", async () => {
  const archivedAt = Date.now() - 1000;
  const storePath = store({ ...tombstoneEntry, archivedAt, status: "failed" });
  const admitted = owned(
    await admitStored(storePath, {
      resetTriggered: true,
      allowRestartTombstoneReset: true,
    }),
  );
  expect(entry(storePath)).toMatchObject({
    sessionId,
    archivedAt,
    mainRestartRecovery: { tombstone: { recoveredSessionId: "dashboard-successor" } },
  });
  admitted.complete();
});
it("does not treat resetTriggered alone as restart-tombstone authority", async () => {
  await expect(admitStored(store(tombstoneEntry), { resetTriggered: true })).rejects.toMatchObject({
    code: SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
    message: expect.stringMatching(/ended during restart recovery/i),
  });
});
it.each([true, false])(
  "requires terminal evidence to retire recovery fences: %s",
  async (terminal) => {
    const storePath = store({
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
      ...(terminal ? { restartRecoveryTerminalRunIds: ["stale-run"] } : {}),
    });
    const before = entry(storePath);
    expect(before?.status).toBeUndefined();
    if (!terminal) {
      await expect(admitStored(storePath)).rejects.toMatchObject({
        code: "SESSION_WORK_START_CHANGED",
      });
      expect(entry(storePath)).toEqual(before);
      return;
    }
    const admitted = owned(await admitStored(storePath));
    expect(admitted.sessionId).toBe(sessionId);
    const current = entry(storePath);
    expect(current?.restartRecoveryRuns).toBeUndefined();
    expect(current?.mainRestartRecovery).toBeUndefined();
    admitted.complete();
  },
);
it("schedules released recovery only after retained admission exits", async () => {
  const storePath = store(interruptedEntry);
  const blocker = operation();
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  const result = await adopt(storePath, reservation, {
    retainLifecycleAdmissionOnActive: true,
  });
  expect(result).toMatchObject(activeRunSkipped);
  expect(releaseMocks.schedule).not.toHaveBeenCalled();
  expect(entry(storePath)).not.toHaveProperty("mainRestartRecovery.foregroundClaims");
  if (result.status === "skipped") {
    result.lifecycleAdmission?.release();
  }
  await vi.waitFor(() =>
    expect(releaseMocks.schedule).toHaveBeenCalledWith({ ...scope, storePath }),
  );
  blocker.complete();
  reservation.complete();
});
it("excludes the initiating reply admission from an in-band lifecycle mutation", async () => {
  const storePath = store();
  const admitted = owned(await admitStored(storePath));
  await runWithReplyOperationLifecycleAdmission(admitted, () =>
    interrupt(storePath, async () => {}),
  );
  expect(admitted.abortSignal.aborted).toBe(false);
  admitted.complete();
});
it("skips an aborted reply waiting behind a lifecycle mutation", async () => {
  const storePath = store();
  const release = await holdMutation(storePath);
  const admission = abortableAdmission({ storePath });
  admission.abort();
  await release();
  await expect(admission.promise).resolves.toEqual({ status: "skipped", reason: "aborted" });
});
it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
  vi.useFakeTimers();
  const active = operation();
  const barrier = createDeferred();
  const admission = observe(admit({ sessionId: "queued-session", kind: "queued_followup" }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    active.completeWithAfterClearBarrier(barrier.promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(admission.settled).toBe(false);
  } finally {
    active.complete();
    barrier.resolve();
    owned(await admission.promise).complete();
  }
});
it("skips heartbeat turns while delivery settles", async () => {
  const active = operation();
  const barrier = createDeferred();
  active.completeWithAfterClearBarrier(barrier.promise);
  await expect(admit({ sessionId: "heartbeat-session", kind: "heartbeat" })).resolves.toEqual(
    activeRunSkipped,
  );
  barrier.resolve();
  await barrier.promise;
});
it("uses the active run's final session id after waiting", async () => {
  const active = operation();
  active.setPhase("preflight_compacting");
  const admission = admit({ sessionId: "new-session" });
  await Promise.resolve();
  active.updateSessionId("post-compact-session");
  active.complete();
  const result = owned(await admission);
  expect(result.sessionId).toBe("post-compact-session");
  result.complete();
});
it("keeps visible turns waiting while an active operation is still fresh", async () => {
  vi.useFakeTimers();
  const active = operation();
  active.setPhase("running");
  active.recordActivity();
  const admission = abortableAdmission({ sessionId: "waiting-session" });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  expect(admission.settled).toBe(false);
  expect(replyRunRegistry.get(sessionKey)).toBe(active);
  admission.abort();
  await expect(admission.promise).resolves.toMatchObject({
    status: "skipped",
    reason: "aborted",
    activeOperation: active,
  });
});
it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const active = operation();
  const cancel = vi.fn(() => active.complete());
  active.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
  active.setPhase("running");
  markDiagnosticToolStartedForTest({ ...scope, toolName: "exec", toolCallId: "tool-quiet-1" });
  vi.setSystemTime(startedAt + 12 * 60_000);
  const admission = abortableAdmission({ sessionId: "replacement" });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  expect(admission.settled).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  vi.setSystemTime(startedAt + 16 * 60_000);
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  const result = owned(await admission.promise);
  expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
  result.complete();
  admission.abort();
});
it("does not let queued followups reclaim a stale active operation", async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const active = operation();
  const cancel = vi.fn();
  active.attachBackend({ kind: "embedded", cancel, isStreaming: () => true });
  active.setPhase("running");
  vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);
  const admission = admit({ sessionId: "replacement", kind: "queued_followup", waitTimeoutMs: 1 });
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(100);
  await expect(admission).resolves.toMatchObject({ ...activeRunSkipped, activeOperation: active });
  expect(cancel).not.toHaveBeenCalled();
  expect(replyRunRegistry.get(sessionKey)).toBe(active);
  active.complete();
});
it("lets visible turns reclaim terminal operations after settle grace elapsed", async () => {
  vi.useFakeTimers();
  const active = operation();
  active.setPhase("running");
  active.abortByUser();
  const admission = admit({ sessionId: "replacement" });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
  const result = owned(await admission);
  expect(active.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
  expect(replyRunRegistry.get(sessionKey)).not.toBe(active);
  result.complete();
});
it.for([false, true])(
  "adopts a reservation and preserves restart=%s",
  async (restart, { signal }) => {
    const storePath = store();
    const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
    expect(owned(await adopt(storePath, reservation))).toBe(reservation);
    expect(reservation.key).toBe(sessionKey);
    expect(replyRunRegistry.get(sourceKey)).toBeUndefined();
    expect(replyRunRegistry.get(sessionKey)).toBe(reservation);
    reservation.setPhase("running");
    const aborted = createDeferred();
    reservation.abortSignal.addEventListener("abort", () => aborted.resolve(), { once: true });
    let mutationRan = false;
    const mutation = interrupt(
      storePath,
      async () => {
        mutationRan = true;
      },
      restart ? createAgentRunRestartAbortError() : undefined,
    );
    try {
      await withinTest(aborted.promise, signal);
      expect(reservation.result).toEqual({
        kind: "aborted",
        code: restart ? "aborted_for_restart" : "aborted_by_user",
      });
      expect(mutationRan).toBe(false);
    } finally {
      reservation.complete();
      await mutation;
    }
    expect(mutationRan).toBe(true);
  },
);
it("skips adoption without waiting when the target run slot is owned", async () => {
  const blocker = operation();
  blocker.setPhase("running");
  const storePath = store({
    restartRecoveryRuns: [
      { runId: "active-run", lifecycleGeneration: getAgentEventLifecycleGeneration() },
    ],
  });
  const before = entry(storePath);
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  const result = await adopt(storePath, reservation);
  expect(result).toMatchObject({ ...activeRunSkipped, activeOperation: blocker });
  expect(reservation).toMatchObject({ key: sourceKey, result: null });
  expect(replyRunRegistry.get(sourceKey)).toBe(reservation);
  expect(replyRunRegistry.get(sessionKey)).toBe(blocker);
  expect(entry(storePath)).toEqual(before);
  blocker.complete();
  reservation.complete();
});
