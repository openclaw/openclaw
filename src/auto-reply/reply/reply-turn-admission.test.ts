import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  "../../agents/main-session-recovery/main-session-recovery-store.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../agents/main-session-recovery/main-session-recovery-store.js")
      >();
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
  "../../agents/main-session-recovery/main-session-recovery-owner-release.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../agents/main-session-recovery/main-session-recovery-owner-release.js")
    >()),
    scheduleMainSessionRecoveryPendingTarget: releaseMocks.schedule,
  }),
);

const sessionKey = "agent:main:telegram:topic:admission";
const sessionId = "original-session";
const scope = { sessionKey, sessionId };
const sourceKey = "agent:main:telegram:slash:source";
function admit(overrides: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {}) {
  return admitTestReplyTurn({ ...scope, ...overrides });
}
function operation(overrides: Partial<Parameters<typeof createReplyOperation>[0]> = {}) {
  return createReplyOperation({ ...scope, resetTriggered: false, ...overrides });
}
function owned(result: Awaited<ReturnType<typeof admit>>) {
  expect(result.status).toBe("owned");
  if (result.status !== "owned") {
    throw new Error("Expected reply ownership");
  }
  return result.operation;
}
function store(entry: Partial<SessionEntry> = {}) {
  return createSessionStore({ [sessionKey]: { sessionId, updatedAt: 100, ...entry } });
}
function interruptedEntry(): SessionEntry {
  return {
    sessionId,
    updatedAt: 100,
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
  };
}
function tombstoneEntry(): SessionEntry {
  return {
    sessionId,
    updatedAt: 100,
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
  };
}
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
    expect(
      loadSessionEntry({ storePath, sessionKey: key })?.mainRestartRecovery?.foregroundClaims,
    ).toBeUndefined(),
  );
}
function interrupt(storePath: string, run: () => Promise<void>) {
  const target = { scope: storePath, identities: [sessionKey, sessionId] };
  return runExclusiveSessionLifecycleMutation("patch", {
    ...target,
    prepare: async () => {
      await interruptSessionWorkAdmissions(target);
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
  await expect(admission).rejects.toThrow(
    `Session "${sessionKey}" is archived. Restore it before starting new work.`,
  );
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
  const admission = admit({ storePath, expectedSessionId: sessionId });
  await release();
  await expect(admission).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
});
it("waits for recovery release before admitting a queued successor", async () => {
  const storePath = store(interruptedEntry());
  const owner = owned(await admit({ storePath, expectedSessionId: sessionId }));
  const release = holdRecoveryRelease();
  owner.complete();
  await release.started;
  let settled = false;
  const successor = admit({
    storePath,
    expectedSessionId: sessionId,
    kind: "queued_followup",
  }).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  await expect(
    admit({ storePath, expectedSessionId: sessionId, kind: "heartbeat" }),
  ).resolves.toEqual({ status: "skipped", reason: "active-run" });
  release.release();
  owned(await successor).complete();
  await expectRecoveryReleased(storePath);
});
it("preserves a source recovery identity after adopting a distinct target session", async () => {
  const storePath = createSessionStore({
    [sourceKey]: interruptedEntry(),
    [sessionKey]: { sessionId: "target-session", updatedAt: 100 },
  });
  const source = owned(
    await admit({ sessionKey: sourceKey, storePath, expectedSessionId: sessionId }),
  );
  const adopted = owned(
    await admit({
      storePath,
      expectedSessionId: "target-session",
      waitForActive: false,
      adoptOperation: source,
    }),
  );
  adopted.updateSessionId("target-session");
  expect(adopted).toBe(source);
  expect(adopted.key).toBe(sessionKey);
  expect(adopted.sessionId).toBe("target-session");
  const release = holdRecoveryRelease();
  adopted.complete();
  await release.started;
  let settled = false;
  const successor = admit({ sessionKey: sourceKey, storePath, expectedSessionId: sessionId }).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  release.release();
  const next = owned(await successor);
  expect(next.sessionId).toBe(sessionId);
  next.complete();
  await expectRecoveryReleased(storePath, sourceKey);
});
it("admits an explicit reset without reopening its restart tombstone", async () => {
  const archivedAt = Date.now() - 1000;
  const storePath = store({ ...tombstoneEntry(), archivedAt, status: "failed" });
  const admitted = owned(
    await admit({
      storePath,
      expectedSessionId: sessionId,
      resetTriggered: true,
      allowRestartTombstoneReset: true,
    }),
  );
  expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
    sessionId,
    archivedAt,
    mainRestartRecovery: { tombstone: { recoveredSessionId: "dashboard-successor" } },
  });
  admitted.complete();
});
it("does not treat resetTriggered alone as restart-tombstone authority", async () => {
  await expect(
    admit({
      storePath: store(tombstoneEntry()),
      expectedSessionId: sessionId,
      resetTriggered: true,
    }),
  ).rejects.toMatchObject({
    code: SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
    message: expect.stringMatching(/ended during restart recovery/i),
  });
});
it.each([true, false])(
  "requires terminal evidence before retiring recovery fences at visible admission: %s",
  async (terminal) => {
    const storePath = store({
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
      ...(terminal ? { restartRecoveryTerminalRunIds: ["stale-run"] } : {}),
    });
    const before = loadSessionEntry({ storePath, sessionKey });
    expect(before?.status).toBeUndefined();
    if (!terminal) {
      await expect(admit({ storePath, expectedSessionId: sessionId })).rejects.toMatchObject({
        code: "SESSION_WORK_START_CHANGED",
      });
      expect(loadSessionEntry({ storePath, sessionKey })).toEqual(before);
      return;
    }
    const admitted = owned(await admit({ storePath, expectedSessionId: sessionId }));
    expect(admitted.sessionId).toBe(sessionId);
    const entry = loadSessionEntry({ storePath, sessionKey });
    expect(entry?.restartRecoveryRuns).toBeUndefined();
    expect(entry?.mainRestartRecovery).toBeUndefined();
    admitted.complete();
  },
);
it("schedules released recovery only after retained admission exits", async () => {
  const storePath = store(interruptedEntry());
  const blocker = operation();
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  const result = await admit({
    storePath,
    sessionId: reservation.sessionId,
    expectedSessionId: sessionId,
    waitForActive: false,
    retainLifecycleAdmissionOnActive: true,
    adoptOperation: reservation,
  });
  expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
  expect(releaseMocks.schedule).not.toHaveBeenCalled();
  expect(loadSessionEntry({ storePath, sessionKey })).not.toHaveProperty(
    "mainRestartRecovery.foregroundClaims",
  );
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
  const admitted = owned(await admit({ storePath, expectedSessionId: sessionId }));
  await runWithReplyOperationLifecycleAdmission(admitted, () =>
    interrupt(storePath, async () => {}),
  );
  expect(admitted.abortSignal.aborted).toBe(false);
  admitted.complete();
});
it("skips an aborted reply waiting behind a lifecycle mutation", async () => {
  const storePath = store();
  const release = await holdMutation(storePath);
  const controller = new AbortController();
  const admission = admit({ storePath, upstreamAbortSignal: controller.signal });
  controller.abort();
  await release();
  await expect(admission).resolves.toEqual({ status: "skipped", reason: "aborted" });
});
it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
  vi.useFakeTimers();
  const active = operation();
  const barrier = createDeferred();
  let settled = false;
  const admission = admit({ sessionId: "queued-session", kind: "queued_followup" }).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    active.completeWithAfterClearBarrier(barrier.promise);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  } finally {
    active.complete();
    barrier.resolve();
    owned(await admission).complete();
  }
});
it("skips heartbeat turns while delivery settles", async () => {
  const active = operation();
  const barrier = createDeferred();
  active.completeWithAfterClearBarrier(barrier.promise);
  await expect(admit({ sessionId: "heartbeat-session", kind: "heartbeat" })).resolves.toEqual({
    status: "skipped",
    reason: "active-run",
  });
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
  const controller = new AbortController();
  let settled = false;
  const admission = admit({
    sessionId: "waiting-session",
    upstreamAbortSignal: controller.signal,
  }).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  expect(settled).toBe(false);
  expect(replyRunRegistry.get(sessionKey)).toBe(active);
  controller.abort();
  await expect(admission).resolves.toMatchObject({
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
  const controller = new AbortController();
  let settled = false;
  const admission = admit({
    sessionId: "replacement",
    upstreamAbortSignal: controller.signal,
  }).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  expect(settled).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
  vi.setSystemTime(startedAt + 16 * 60_000);
  await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
  const result = owned(await admission);
  expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
  result.complete();
  controller.abort();
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
  await expect(admission).resolves.toMatchObject({
    status: "skipped",
    reason: "active-run",
    activeOperation: active,
  });
  expect(cancel).not.toHaveBeenCalled();
  expect(replyRunRegistry.get(sessionKey)).toBe(active);
  active.complete();
});
it.each(["complete", "cancel"] as const)(
  "retains a new visible input while the predecessor has committed output but is closing: %s",
  async (outcome) => {
    vi.useFakeTimers();
    const active = operation();
    active.setPhase("running");
    active.attachBackend({ kind: "embedded", cancel: vi.fn(), isStreaming: () => false });
    active.freezeAbort();
    const controller = new AbortController();
    let settled = false;
    const waiting = admit({
      waitForActive: false,
      retainLifecycleAdmissionOnActive: true,
      upstreamAbortSignal: controller.signal,
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(replyRunRegistry.get(sessionKey)).toBe(active);
    expect(active.result).toBeNull();
    if (outcome === "cancel") {
      controller.abort();
    } else {
      active.complete();
    }
    const result = await waiting;
    if (outcome === "cancel") {
      expect(result).toMatchObject({ status: "skipped", reason: "aborted" });
    } else {
      const next = owned(result);
      expect(next.sessionId).toBe(sessionId);
      next.complete();
    }
    expect(active.result).toEqual(outcome === "complete" ? { kind: "completed" } : null);
    active.complete();
  },
);

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
it("adopts a source-keyed command reservation into the target run slot", async () => {
  const storePath = store();
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  expect(
    owned(
      await admit({
        storePath,
        sessionId: reservation.sessionId,
        expectedSessionId: sessionId,
        waitForActive: false,
        adoptOperation: reservation,
      }),
    ),
  ).toBe(reservation);
  expect(reservation.key).toBe(sessionKey);
  expect(replyRunRegistry.get(sourceKey)).toBeUndefined();
  expect(replyRunRegistry.get(sessionKey)).toBe(reservation);
  reservation.setPhase("running");
  let mutationRan = false;
  const mutation = interrupt(storePath, async () => {
    mutationRan = true;
  });
  await vi.waitFor(() => expect(reservation.abortSignal.aborted).toBe(true));
  expect(reservation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
  expect(mutationRan).toBe(false);
  reservation.complete();
  await mutation;
  expect(mutationRan).toBe(true);
});
it("skips adoption without waiting when the target run slot is owned", async () => {
  const blocker = operation();
  blocker.setPhase("running");
  const storePath = store({
    restartRecoveryRuns: [
      { runId: "active-run", lifecycleGeneration: getAgentEventLifecycleGeneration() },
    ],
  });
  const before = loadSessionEntry({ storePath, sessionKey });
  const reservation = operation({ sessionKey: sourceKey, sessionId: "source-session" });
  const result = await admit({
    storePath,
    sessionId: reservation.sessionId,
    expectedSessionId: sessionId,
    waitForActive: false,
    adoptOperation: reservation,
  });
  expect(result).toMatchObject({
    status: "skipped",
    reason: "active-run",
    activeOperation: blocker,
  });
  expect(reservation.key).toBe(sourceKey);
  expect(replyRunRegistry.get(sourceKey)).toBe(reservation);
  expect(replyRunRegistry.get(sessionKey)).toBe(blocker);
  expect(reservation.result).toBeNull();
  expect(loadSessionEntry({ storePath, sessionKey })).toEqual(before);
  blocker.complete();
  reservation.complete();
});
