// Tests reply turn admission decisions for active, queued, and aborted runs.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createReplyOperation,
  replyRunRegistry,
  runAfterReplyOperationClear,
  testing,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { admitReplyTurn, runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createSessionStore(entries: Record<string, object>): string {
  const root = tempDirs.make("openclaw-reply-admission-");
  const storePath = path.join(root, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries));
  return storePath;
}

describe("reply turn admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
  });

  it("rejects a reply when an archive commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:archived";
    const sessionId = "session-before-archive";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId, updatedAt: Date.now(), archivedAt: Date.now() },
          }),
        );
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).rejects.toThrow(
      `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    );
  });

  it("rejects a reply when deletion commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:deleted";
    const sessionId = "session-before-delete";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        fs.writeFileSync(storePath, JSON.stringify({}));
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).rejects.toThrow(/deleted while starting work/i);
  });

  it("uses the persisted session id when reset commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:reset";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
          }),
        );
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;
    const result = await admission;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("rejects expected-session work when reset commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:reset-expected";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
          }),
        );
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).rejects.toThrow(/changed while starting work/i);
  });

  it("drops queued work when reset cleanup cancels admission", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const abortController = new AbortController();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        abortController.abort();
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId: "session-after-reset", updatedAt: Date.now() },
          }),
        );
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: abortController.signal,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).resolves.toEqual({
      status: "skipped",
      reason: "aborted",
    });
  });

  it("drops queued work when the session is archived", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-archive";
    const sessionId = "session-before-archive";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        archivedAt: Date.now(),
      },
    });

    await expect(
      admitReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        kind: "queued_followup",
        resetTriggered: false,
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "lifecycle-invalidated",
    });
  });

  it("holds lifecycle admission until a running reply operation clears", async () => {
    const sessionKey = "agent:main:telegram:topic:running-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }
    admission.operation.setPhase("running");
    let mutationRan = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationRan = true;
      },
    });

    await vi.waitFor(() => {
      expect(admission.operation.abortSignal.aborted).toBe(true);
    });
    expect(admission.operation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(mutationRan).toBe(false);

    admission.operation.complete();
    await mutation;
    expect(mutationRan).toBe(true);
  });

  it("holds interrupted queued reply work until its owner exits", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-delete";
    const sessionId = "session-before-delete";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }

    let mutationRan = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationRan = true;
      },
    });

    await vi.waitFor(() => {
      expect(admission.operation.abortSignal.aborted).toBe(true);
    });
    expect(admission.operation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(mutationRan).toBe(false);
    expect(replyRunRegistry.get(sessionKey)).toBe(admission.operation);

    admission.operation.complete();
    await mutation;
    expect(mutationRan).toBe(true);
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
  });

  it("excludes the initiating reply admission from an in-band lifecycle mutation", async () => {
    const sessionKey = "agent:main:telegram:topic:in-band-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }

    await runWithReplyOperationLifecycleAdmission(admission.operation, async () => {
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        prepare: async () => {
          await interruptSessionWorkAdmissions({
            scope: storePath,
            identities: [sessionKey, sessionId],
          });
        },
        run: async () => undefined,
      });
    });

    expect(admission.operation.abortSignal.aborted).toBe(false);
    admission.operation.complete();
  });

  it("skips an aborted reply waiting behind a lifecycle mutation", async () => {
    const sessionKey = "agent:main:telegram:topic:aborted";
    const sessionId = "session-before-abort";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
    });
    await mutationStarted.promise;
    const controller = new AbortController();
    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    controller.abort();
    releaseMutation.resolve();
    await mutation;

    await expect(admission).resolves.toEqual({ status: "skipped", reason: "aborted" });
  });

  it("waits for visible turns and reuses the active session id", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    active.setPhase("running");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
    });

    let settled = false;
    void admitted.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);

    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("active-session");
      result.operation.complete();
    }
  });

  it("does not apply cleanup settle timeout to visible turn admission", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "waiting-session",
        kind: "visible",
        resetTriggered: false,
      });

      let settled = false;
      void admitted.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);

      active.complete();
      const result = await admitted;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps the cleanup settle timeout for queued follow-up retry", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "queued-session",
        kind: "queued_followup",
        resetTriggered: false,
      });

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(admitted).resolves.toMatchObject({
        status: "skipped",
        reason: "active-run",
        activeOperation: active,
      });
      active.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const admitted = admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "queued-session",
      kind: "queued_followup",
      resetTriggered: false,
    });
    let settled = false;
    void admitted.then(() => {
      settled = true;
    });

    await Promise.resolve();
    active.completeWithAfterClearBarrier(barrier);
    await Promise.resolve();

    expect(settled).toBe(false);

    releaseBarrier();
    const result = await admitted;
    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      result.operation.complete();
    }
  });

  it("allows a visible turn to claim the lane while delivery settles", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "visible-session",
      kind: "visible",
      resetTriggered: false,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      result.operation.complete();
    }
    releaseBarrier();
    await barrier;
  });

  it("skips heartbeat turns while delivery settles", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
      resetTriggered: false,
    });

    expect(result).toEqual({ status: "skipped", reason: "active-run" });
    releaseBarrier();
    await barrier;
  });

  it("passes a visible turn's rotated session to after-clear work", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let admissionSessionId: string | undefined;
    runAfterReplyOperationClear(active, (sessionId) => {
      admissionSessionId = sessionId;
    });

    active.completeWithAfterClearBarrier(barrier);
    const visibleAdmission = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "visible-session",
      kind: "visible",
      resetTriggered: false,
    });
    expect(visibleAdmission.status).toBe("owned");
    if (visibleAdmission.status === "owned") {
      visibleAdmission.operation.updateSessionId("rotated-session");
      visibleAdmission.operation.complete();
    }

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => {
      expect(admissionSessionId).toBe("rotated-session");
    });
    const queuedResult = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: admissionSessionId ?? "queued-session",
      kind: "queued_followup",
      resetTriggered: false,
    });
    expect(queuedResult.status).toBe("owned");
    if (queuedResult.status === "owned") {
      expect(queuedResult.operation.sessionId).toBe("rotated-session");
      queuedResult.operation.complete();
    }
  });

  it("uses the active run's final session id after waiting", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "pre-compact-session",
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
    });

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("post-compact-session");
      result.operation.complete();
    }
  });

  it("accepts an expected session id rotated by the active run", async () => {
    const sessionKey = "agent:main:telegram:topic:compaction";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");

    const admitted = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );
    active.updateSessionId(nextSessionId);
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("accepts a rotation already published by the expected active run", async () => {
    const sessionKey = "agent:main:telegram:topic:compaction-before-admission";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );
    active.complete();

    const result = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      expectedActiveOperation: active,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("accepts a rotation published by the live owner after the caller snapshot", async () => {
    const sessionKey = "agent:main:telegram:topic:late-compaction-owner";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );

    const admitted = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: true,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("rejects a fresh post-reset owner as rotation proof", async () => {
    const sessionKey = "agent:main:telegram:topic:fresh-post-reset-owner";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
    });
    const freshOwner = createReplyOperation({
      sessionKey,
      sessionId: nextSessionId,
      resetTriggered: false,
    });

    const admitted = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: true,
    });

    await expect(admitted).rejects.toThrow(/changed while starting work/i);
    freshOwner.complete();
  });

  it.each([
    ["failed", (operation: ReplyOperation) => operation.fail("run_failed")],
    [
      "user-aborted",
      (operation: ReplyOperation) => {
        operation.abortByUser();
        operation.complete();
      },
    ],
  ])("accepts a rotation published before the expected run %s", async (_outcome, finish) => {
    const sessionKey = "agent:main:telegram:topic:compaction-terminal-outcome";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );
    finish(active);

    const result = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      expectedActiveOperation: active,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("skips heartbeat turns while a visible turn owns the lane", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "visible-session",
      resetTriggered: false,
    });

    const result = await admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
      resetTriggered: false,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: active,
    });
    active.complete();
  });

  it("stops waiting when the caller aborts", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    const abortController = new AbortController();
    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "waiting-session",
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(admitted).resolves.toMatchObject({
      status: "skipped",
      reason: "aborted",
      activeOperation: active,
    });
    active.complete();
  });
});
