import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  abortActiveReplyRuns,
  createReplyOperation,
  isReplyRunActiveForSessionId,
  queueReplyRunMessage,
  readReplyRunCreateSeq,
  replyRunRegistry,
  ReplyRunAlreadyActiveError,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "./reply-run-registry.js";

describe("reply run registry", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
    vi.restoreAllMocks();
  });

  it("keeps ownership stable by sessionKey while sessionId rotates", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-old",
        resetTriggered: false,
      });

      const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);

      operation.updateSessionId("session-new");

      expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
      expect(resolveActiveReplyRunSessionId("agent:main:main")).toBe("session-new");
      expect(isReplyRunActiveForSessionId("session-old")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-new")).toBe(true);

      let settled = false;
      void oldWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      operation.complete();

      await expect(oldWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("clears queued operations immediately on user abort", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-queued",
      resetTriggered: false,
    });

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("queues messages only through the active running backend", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });

    expect(queueReplyRunMessage("session-running", "before running")).toBe(false);

    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const compactingOperation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compacting",
      resetTriggered: false,
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
      resetTriggered: false,
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
  });
});

describe("createReplyOperation with force option", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
  });

  it("force-supersedes an existing operation for the same session key", () => {
    const existing = createReplyOperation({
      sessionKey: "agent:main:force-test",
      sessionId: "session-old",
      resetTriggered: false,
    });
    existing.setPhase("running");

    const replacement = createReplyOperation({
      sessionKey: "agent:main:force-test",
      sessionId: "session-new",
      resetTriggered: false,
      force: true,
    });

    // Old operation should be aborted
    expect(existing.result).toEqual({ kind: "aborted", code: "aborted_by_user" });

    // New operation should be active
    expect(replacement.phase).toBe("queued");
    expect(replyRunRegistry.isActive("agent:main:force-test")).toBe(true);
    expect(replacement.sessionId).toBe("session-new");
  });

  it("throws ReplyRunAlreadyActiveError without force", () => {
    createReplyOperation({
      sessionKey: "agent:main:no-force",
      sessionId: "session-existing",
      resetTriggered: false,
    });

    expect(() =>
      createReplyOperation({
        sessionKey: "agent:main:no-force",
        sessionId: "session-new",
        resetTriggered: false,
      }),
    ).toThrow("Reply run already active");
  });

  it("force with no existing operation works normally", () => {
    const op = createReplyOperation({
      sessionKey: "agent:main:force-empty",
      sessionId: "session-1",
      resetTriggered: false,
      force: true,
    });

    expect(op.phase).toBe("queued");
    expect(op.sessionId).toBe("session-1");
  });

  it("force: stale operation's clearState does not delete replacement", () => {
    // Create the original operation and advance it to running
    const existing = createReplyOperation({
      sessionKey: "agent:main:force-race",
      sessionId: "session-old",
      resetTriggered: false,
    });
    existing.setPhase("running");

    // Force-supersede it with a new operation
    const replacement = createReplyOperation({
      sessionKey: "agent:main:force-race",
      sessionId: "session-new",
      resetTriggered: false,
      force: true,
    });
    replacement.setPhase("running");

    // Now simulate the old operation's finally block running complete()
    // (which calls clearState). This must NOT delete the replacement's entries.
    existing.complete();

    // Replacement should still be active
    expect(replyRunRegistry.isActive("agent:main:force-race")).toBe(true);
    expect(resolveActiveReplyRunSessionId("agent:main:force-race")).toBe("session-new");
  });

  it("force-supersede preserves rotated wait aliases for the replacement", async () => {
    vi.useFakeTimers();
    try {
      // Old operation with a rotated sessionId
      const existing = createReplyOperation({
        sessionKey: "agent:main:force-alias",
        sessionId: "session-v1",
        resetTriggered: false,
      });
      existing.setPhase("running");
      existing.updateSessionId("session-v2");

      // A waiter using the OLD sessionId (pre-rotation alias)
      const aliasWaitPromise = waitForReplyRunEndBySessionId("session-v1", 5_000);

      // Force-supersede
      const replacement = createReplyOperation({
        sessionKey: "agent:main:force-alias",
        sessionId: "session-v3",
        resetTriggered: false,
        force: true,
      });
      replacement.setPhase("running");

      // The alias waiter should NOT have resolved yet — the replacement is still running
      let settled = false;
      void aliasWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      // When replacement completes, alias waiter resolves
      replacement.complete();
      await expect(aliasWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});

describe("createReplyOperation with force: { ifStale }", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
  });

  it("supersedes when the registered op is object-identical to ifStale", () => {
    const stale = createReplyOperation({
      sessionKey: "agent:main:stale-identity",
      sessionId: "session-stale",
      resetTriggered: false,
    });
    stale.setPhase("running");

    const replacement = createReplyOperation({
      sessionKey: "agent:main:stale-identity",
      sessionId: "session-replacement",
      resetTriggered: false,
      force: { ifStale: stale },
    });

    expect(stale.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:stale-identity")).toBe(true);
    expect(resolveActiveReplyRunSessionId("agent:main:stale-identity")).toBe("session-replacement");
    expect(replacement.phase).toBe("queued");
  });

  it("throws when a newer op has taken over, even if sessionKey matches", () => {
    // Request A captured this ref; it represents the run A intended to supersede.
    const staleCapturedByA = createReplyOperation({
      sessionKey: "agent:main:burst-race",
      sessionId: "session-stale",
      resetTriggered: false,
    });
    staleCapturedByA.setPhase("running");

    // Simulate the stale op clearing (its finally block ran during A's wait).
    staleCapturedByA.complete();
    expect(replyRunRegistry.isActive("agent:main:burst-race")).toBe(false);

    // Request B arrives and registers its own legitimate op — no force needed.
    const newerB = createReplyOperation({
      sessionKey: "agent:main:burst-race",
      sessionId: "session-newer-b",
      resetTriggered: false,
    });
    newerB.setPhase("running");

    // Request A wakes up from its 500ms wait and retries with ifStale pointing
    // at its original captured ref.  The registered op is newerB, NOT the
    // staleCapturedByA ref — so the identity gate must refuse the force.
    expect(() =>
      createReplyOperation({
        sessionKey: "agent:main:burst-race",
        sessionId: "session-retry-a",
        resetTriggered: false,
        force: { ifStale: staleCapturedByA },
      }),
    ).toThrow(ReplyRunAlreadyActiveError);

    // The legitimate newer op must still be active and untouched.
    expect(newerB.result).toBeNull();
    expect(replyRunRegistry.isActive("agent:main:burst-race")).toBe(true);
    expect(resolveActiveReplyRunSessionId("agent:main:burst-race")).toBe("session-newer-b");
  });

  it("creates normally when nothing is registered, regardless of ifStale", () => {
    const orphanRef = createReplyOperation({
      sessionKey: "agent:main:orphan-ref",
      sessionId: "session-orphan",
      resetTriggered: false,
    });
    orphanRef.complete();
    expect(replyRunRegistry.isActive("agent:main:orphan-ref")).toBe(false);

    // ifStale points at a completed op; but since nothing is registered,
    // we don't enter the conflict branch and creation should succeed.
    const fresh = createReplyOperation({
      sessionKey: "agent:main:orphan-ref",
      sessionId: "session-fresh",
      resetTriggered: false,
      force: { ifStale: orphanRef },
    });

    expect(fresh.phase).toBe("queued");
    expect(replyRunRegistry.isActive("agent:main:orphan-ref")).toBe(true);
    expect(resolveActiveReplyRunSessionId("agent:main:orphan-ref")).toBe("session-fresh");
  });

  it("matches ifStale by object identity even after the stale op rotates sessionId", () => {
    const stale = createReplyOperation({
      sessionKey: "agent:main:stale-rotation",
      sessionId: "session-before-rotate",
      resetTriggered: false,
    });
    stale.setPhase("running");
    stale.updateSessionId("session-after-rotate");

    // The captured ref survives sessionId rotation — identity is the object,
    // not the sessionId.
    const replacement = createReplyOperation({
      sessionKey: "agent:main:stale-rotation",
      sessionId: "session-replacement",
      resetTriggered: false,
      force: { ifStale: stale },
    });

    expect(stale.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:stale-rotation")).toBe(true);
    expect(resolveActiveReplyRunSessionId("agent:main:stale-rotation")).toBe("session-replacement");
    expect(replacement.phase).toBe("queued");
  });
});

describe("readReplyRunCreateSeq", () => {
  afterEach(() => {
    __testing.resetReplyRunRegistry();
  });

  it("returns 0 for a key that has never had an operation created", () => {
    expect(readReplyRunCreateSeq("agent:main:never-seen")).toBe(0);
  });

  it("increments monotonically on each successful create", () => {
    const key = "agent:main:seq-monotonic";
    expect(readReplyRunCreateSeq(key)).toBe(0);

    const first = createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });
    expect(readReplyRunCreateSeq(key)).toBe(1);

    first.complete();
    // Completion must NOT decrement — callers captured the value under the
    // assumption that a later increment signals "a new operation ran".
    expect(readReplyRunCreateSeq(key)).toBe(1);

    const second = createReplyOperation({
      sessionKey: key,
      sessionId: "session-2",
      resetTriggered: false,
    });
    expect(readReplyRunCreateSeq(key)).toBe(2);
    second.complete();
    expect(readReplyRunCreateSeq(key)).toBe(2);
  });

  it("advances on force-supersede (force: true)", () => {
    const key = "agent:main:seq-force";
    const original = createReplyOperation({
      sessionKey: key,
      sessionId: "session-original",
      resetTriggered: false,
    });
    original.setPhase("running");
    const seqAfterOriginal = readReplyRunCreateSeq(key);
    expect(seqAfterOriginal).toBe(1);

    createReplyOperation({
      sessionKey: key,
      sessionId: "session-replacement",
      resetTriggered: false,
      force: true,
    });
    expect(readReplyRunCreateSeq(key)).toBe(2);
  });

  it("advances on identity-gated force-supersede", () => {
    const key = "agent:main:seq-force-ifstale";
    const original = createReplyOperation({
      sessionKey: key,
      sessionId: "session-original",
      resetTriggered: false,
    });
    original.setPhase("running");
    expect(readReplyRunCreateSeq(key)).toBe(1);

    createReplyOperation({
      sessionKey: key,
      sessionId: "session-replacement",
      resetTriggered: false,
      force: { ifStale: original },
    });
    expect(readReplyRunCreateSeq(key)).toBe(2);
  });

  it("does NOT advance when createReplyOperation throws", () => {
    const key = "agent:main:seq-throw";
    createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });
    expect(readReplyRunCreateSeq(key)).toBe(1);

    expect(() =>
      createReplyOperation({
        sessionKey: key,
        sessionId: "session-2",
        resetTriggered: false,
      }),
    ).toThrow(ReplyRunAlreadyActiveError);
    expect(readReplyRunCreateSeq(key)).toBe(1);
  });

  it("survives sessionId rotation — rotation does not increment", () => {
    const key = "agent:main:seq-rotation";
    const op = createReplyOperation({
      sessionKey: key,
      sessionId: "session-v1",
      resetTriggered: false,
    });
    expect(readReplyRunCreateSeq(key)).toBe(1);

    op.updateSessionId("session-v2");
    expect(readReplyRunCreateSeq(key)).toBe(1);
    op.updateSessionId("session-v3");
    expect(readReplyRunCreateSeq(key)).toBe(1);
  });

  it("detects the P2 race: stale cleared + newer op ran + cleared in the wait window", () => {
    // Models the interrupt-mode retry path:
    //   - Request A captures staleSeq before its 500ms wait.
    //   - During the wait, the original op clears, request B creates and
    //     completes its own op.
    //   - A's retry reads the current seq; it must NOT match staleSeq.
    const key = "agent:main:p2-race";

    // Original stuck op that A collides with.
    const original = createReplyOperation({
      sessionKey: key,
      sessionId: "session-original",
      resetTriggered: false,
    });
    original.setPhase("running");

    // A's capture point — synchronously after the (simulated) throw.
    const staleSeq = readReplyRunCreateSeq(key);
    expect(staleSeq).toBe(1);

    // During A's wait: original clears, B creates and completes.
    original.complete();
    const newerB = createReplyOperation({
      sessionKey: key,
      sessionId: "session-newer-b",
      resetTriggered: false,
    });
    newerB.setPhase("running");
    newerB.complete();

    // Registry is idle now, but seq has advanced — A must detect this.
    expect(replyRunRegistry.isActive(key)).toBe(false);
    expect(readReplyRunCreateSeq(key)).toBeGreaterThan(staleSeq);
  });

  it("confirms the no-race case: stale cleared, nobody took over — seq unchanged", () => {
    const key = "agent:main:no-race";
    const original = createReplyOperation({
      sessionKey: key,
      sessionId: "session-original",
      resetTriggered: false,
    });
    original.setPhase("running");
    const staleSeq = readReplyRunCreateSeq(key);

    // Clean exit, nobody else creates.
    original.complete();

    expect(replyRunRegistry.isActive(key)).toBe(false);
    expect(readReplyRunCreateSeq(key)).toBe(staleSeq);
  });

  it("is cleared by __testing.resetReplyRunRegistry", () => {
    const key = "agent:main:seq-reset";
    createReplyOperation({
      sessionKey: key,
      sessionId: "session-1",
      resetTriggered: false,
    });
    expect(readReplyRunCreateSeq(key)).toBe(1);

    __testing.resetReplyRunRegistry();
    expect(readReplyRunCreateSeq(key)).toBe(0);
  });
});
