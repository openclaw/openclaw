import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import { scheduleFollowupDrain } from "../auto-reply/reply/queue/drain.js";
import { reserveSteerCandidate, enqueueFollowupRun } from "../auto-reply/reply/queue/enqueue.js";
import { admitFollowupRunLifecycle } from "../auto-reply/reply/queue/lifecycle.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { deferSessionControllerClaimBeforeExecution } from "./session-controller.mailbox-claim.js";
import { reserveSessionControllerClaimPredecessor } from "./session-controller.mailbox-predecessor.js";
import {
  reserveSessionControllerSource,
  bindSessionControllerSource,
  claimSessionControllerInput,
  releaseSessionControllerClaim,
  retireSessionControllerInput,
  holdSessionControllerSourceWithdrawal,
  abortSessionControllerInput,
  getExistingSessionControllerMailbox,
  captureSessionControllerSourceSettlement,
  beginSessionControllerSourceInjection,
  claimSessionControllerTask,
  tryClaimSessionControllerTask,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import {
  findSessionControllerEntry,
  getSessionControllerEntryForOperation,
} from "./session-controller.state.js";
import { captureSessionTarget } from "./session-controller.target.js";
const key = "agent:mailbox:test";
const ownedInjections: ReturnType<typeof beginSessionControllerSourceInjection>[] = [];
const ownedInputs: ReturnType<typeof reserveSessionControllerSource>[] = [];
const ownedOperations: ReturnType<typeof createReplyOperation>[] = [];
function reserveSource(
  options: Partial<Parameters<typeof reserveSessionControllerSource>[1]> = {},
) {
  const input = reserveSessionControllerSource(key, { policy: { mode: "followup" }, ...options });
  ownedInputs.push(input);
  return input;
}
function interruptSource(protocolRunId?: string) {
  return reserveSource({ protocolRunId, policy: { mode: "interrupt" } });
}
function activeOperation(
  sessionId: string,
  options: Partial<Parameters<typeof createReplyOperation>[0]> = {},
) {
  const operation = createReplyOperation({
    sessionKey: key,
    sessionId,
    resetTriggered: false,
    ...options,
  });
  ownedOperations.push(operation);
  return operation;
}
async function releaseClaim(claim: Parameters<typeof releaseSessionControllerClaim>[0]) {
  releaseSessionControllerClaim(claim);
  await claim.settlement.promise;
}
function claimSource(input: Parameters<typeof tryClaimSessionControllerTask>[0]) {
  const claim = tryClaimSessionControllerTask(input);
  assert(claim, "expected selected source claim");
  return claim;
}
function observeAdmission(injection: ReturnType<typeof beginSessionControllerSourceInjection>) {
  const admitted = vi.fn();
  const pending = injection.admit().then((value) => {
    admitted(value);
    return value;
  });
  return { admitted, pending };
}
async function settleInputs(...inputs: ReturnType<typeof reserveSource>[]) {
  for (const input of inputs) {
    retireSessionControllerInput(input);
  }
  await Promise.all(
    inputs.map(async (input) => {
      await input.settlement.promise;
      await input.claim?.settlement.promise;
    }),
  );
}
function inject(input: ReturnType<typeof reserveSource>) {
  const injection = beginSessionControllerSourceInjection(input);
  ownedInjections.push(injection);
  return injection;
}

afterEach(async () => {
  for (const operation of ownedOperations.splice(0)) {
    operation.complete();
  }
  for (const injection of ownedInjections.splice(0)) {
    injection.finish(false);
  }
  findSessionControllerEntry(key)?.active?.complete();
  clearFollowupQueue(key);
  for (const input of ownedInputs) {
    if (input.claim) {
      releaseSessionControllerClaim(input.claim);
    }
  }
  await settleInputs(...ownedInputs.splice(0));
  vi.useRealTimers();
});
function source(prompt: string) {
  const run = createQueueTestRun({ prompt });
  run.run.sessionKey = key;
  return run;
}
function revocableAuthority(message: string, beforeThrow?: () => void) {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    authority: {
      assertCurrent() {
        if (!current) {
          beforeThrow?.();
          throw new Error(message);
        }
      },
    },
  };
}

describe("controller mailbox scheduling", () => {
  it.each([-90_000, 90_000])(
    "preserves the debounce window after a %d ms wall-clock step",
    async (step) => {
      vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
      const run = source("debounced follow-up");
      const dispatch = vi.fn(async () => {});
      enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 500 }, "none", dispatch, false);
      ownedInputs.push(run.controllerInput!);

      vi.setSystemTime(Date.now() + step);
      scheduleFollowupDrain(key, dispatch);
      await vi.advanceTimersByTimeAsync(499);
      expect(dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(dispatch).toHaveBeenCalledOnce();
    },
  );

  it("drains a re-enqueued incognito followup from its original owner", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:dashboard:incognito-recovery-mailbox";
    const sessionId = "incognito-recovery-session";
    const active = activeOperation(sessionId, {
      sessionKey,
      target: captureSessionTarget({
        storeScope: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
        sessionKey,
        agentId: "main",
        incarnation: sessionId,
      }),
    });
    const owner = getSessionControllerEntryForOperation(active);
    const retry = createQueueTestRun({ prompt: "Deliver the missing source reply." });
    retry.run = { ...retry.run, agentId: "main", sessionKey, sessionId };
    const delivered: string[] = [];
    const dispatch = vi.fn(async (run: typeof retry) => {
      delivered.push(run.prompt);
    });
    expect(
      enqueueFollowupRun(
        sessionKey,
        retry,
        { mode: "followup", debounceMs: 0 },
        "none",
        dispatch,
        false,
        { position: "front" },
      ),
    ).toBe(true);
    if (retry.controllerInput) {
      ownedInputs.push(retry.controllerInput);
    }
    scheduleFollowupDrain(sessionKey, dispatch, owner);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual([]);
    active.complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["Deliver the missing source reply."]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each(["settled", "cancelled", "interrupted"] as const)(
    "restores pre-execution custody only after its %s predecessor permits it",
    async (outcome) => {
      const cancelled = new AbortController();
      const selected = reserveSource(
        outcome === "cancelled" ? { adapter: { signal: cancelled.signal } } : {},
      );
      const selectedClaim = claimSource(selected);
      const predecessor = reserveSessionControllerClaimPredecessor(selectedClaim, {
        policy: { mode: "followup" },
      });
      expect(selected.mailbox.claim).toBeUndefined();
      expect(selected.mailbox.entries).toEqual([predecessor.input, selected]);
      expect(selected.phase).toBe("claimed");
      if (outcome === "cancelled") {
        cancelled.abort(new Error("cancel selected source"));
        await expect(predecessor.restored).resolves.toBe(false);
        await releaseClaim(selectedClaim);
      }
      const predecessorClaim = await claimSessionControllerTask(predecessor.input, () => {});
      const interrupt =
        outcome === "interrupted"
          ? claimSessionControllerTask(interruptSource(), () => {})
          : undefined;
      await releaseClaim(predecessorClaim);
      if (interrupt) {
        const priorityClaim = await interrupt;
        expect(selected.mailbox.claim).toBe(priorityClaim);
        expect(selected.mailbox.claim).not.toBe(selectedClaim);
        await releaseClaim(priorityClaim);
      }
      if (outcome === "cancelled") {
        expect(selected.mailbox.claim).not.toBe(selectedClaim);
        expect(selected.retirementRequested).toBe(true);
      } else {
        await expect(predecessor.restored).resolves.toBe(true);
        expect(selected.mailbox.claim).toBe(selectedClaim);
        expect(selected.claim).toBe(selectedClaim);
        expect(selected.phase).toBe("claimed");
      }
    },
  );

  it("keeps later injection behind a preparing tail after joining a recovery predecessor", async () => {
    const selected = earlySource();
    const selectedClaim = claimSource(selected);
    const recovery = {
      reservationId: "owed:joined-predecessor",
      policy: { mode: "followup" as const },
    };
    const existing = reserveSource(recovery);
    const tail = earlySource();
    const predecessor = reserveSessionControllerClaimPredecessor(selectedClaim, recovery);
    expect(predecessor.created).toBe(false);
    expect(predecessor.input).toBe(existing);
    const predecessorClaim = await claimSessionControllerTask(existing, () => {});
    const later = earlySource();
    const laterInjection = inject(later);
    const { admitted: admittedLater, pending: laterAdmission } = observeAdmission(laterInjection);
    const tailInjection = inject(tail);
    const tailAdmission = tailInjection.admit();
    try {
      await expect(tailAdmission).resolves.toBe(true);
      expect(admittedLater).not.toHaveBeenCalled();
      tailInjection.finish(false);
      await expect(laterAdmission).resolves.toBe(true);
    } finally {
      tailInjection.finish(false);
      laterInjection.finish(false);
      await releaseClaim(predecessorClaim);
      await predecessor.restored;
      releaseSessionControllerClaim(selectedClaim);
      await settleInputs(tail, later);
      await Promise.allSettled([tailAdmission, laterAdmission, selectedClaim.settlement.promise]);
    }
  });

  it.each(["ready", "task"] as const)(
    "releases the consumed %s callback before a source retry",
    async (kind) => {
      const input = reserveSource();
      const run = source("retry after preflight refusal");
      bindSessionControllerSource(input, run);
      const request = () =>
        kind === "ready"
          ? claimSessionControllerInput(run)
          : claimSessionControllerTask(input, () => {});
      const first = await request();
      expect(deferSessionControllerClaimBeforeExecution(first)).toBe(true);
      await releaseClaim(first);
      expect(input.mailbox.claim).toBeUndefined();
      const retried = await request();
      expect(retried).not.toBe(first);
      expect(retried.inputs).toContain(input);
    },
  );
  it("retires a queued injection before releasing its receipt when live authority rejects", async () => {
    const active = activeOperation("active");
    const authority = revocableAuthority("source authority revoked", () => active.complete());
    const input = reserveSource({
      policy: { mode: "followup", debounceMs: 0 },
      adapter: { authority: authority.authority },
    });
    const run = source("must not execute");
    bindSessionControllerSource(input, run);
    const dispatch = vi.fn(async () => {});
    const injection = reserveSteerCandidate(
      key,
      run,
      { mode: "followup", debounceMs: 0 },
      dispatch,
    );
    authority.revoke();
    await expect(injection?.admit()).rejects.toThrow("source authority revoked");
    await captureSessionControllerSourceSettlement(input);
    expect(dispatch).not.toHaveBeenCalled();
    expect(findSessionControllerEntry(key)).toBeUndefined();
  });
  it("reserves interrupt D before A settles, then keeps B,C in original order", async () => {
    const a = activeOperation("a");
    const order: string[] = [];
    const drained = createDeferredCore();
    const dispatch = async (run: ReturnType<typeof source>) => {
      order.push(run.prompt);
      if (run.prompt === "C") {
        drained.resolve();
      }
    };
    const queued = [source("B"), source("C")];
    for (const run of queued) {
      enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 0 }, "none", dispatch);
    }
    const older = interruptSource("old");
    const d = interruptSource(" D ");
    retireSessionControllerInput(older);
    expect(getExistingSessionControllerMailbox(key)?.priority).toBe(d);
    a.complete();
    expect(order).toEqual([]);
    const run = source("D");
    bindSessionControllerSource(d, run);
    const claim = await claimSessionControllerInput(run);
    expect(claim.inputs).toEqual([d]);
    expect(order).toEqual([]);
    releaseSessionControllerClaim(claim);
    await drained.promise;
    expect(order).toEqual(["B", "C"]);
    await queued[1]!.controllerInput!.settlement.promise;
    await queued[1]!.controllerInput!.claim?.settlement.promise;
    expect(Boolean(findSessionControllerEntry(key))).toBe(false);
  });
  it("preserves exact protocol identities and withdrawal custody before payload exists", () => {
    const cancel = vi.fn();
    const input = reserveSource({
      protocolRunId: " id ",
      adapter: { cancel },
    });
    expect(input.protocolRunId).toBe(" id ");
    expect(getExistingSessionControllerMailbox(key)?.entries).toEqual([input]);
    const release = holdSessionControllerSourceWithdrawal(input);
    expect(abortSessionControllerInput(input)).toBe(false);
    release();
    release();
    expect(abortSessionControllerInput(input)).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(findSessionControllerEntry(key)).toBeUndefined();
  });
  it("runs an explicit source task between collect-mode followups instead of collecting its payload", async () => {
    const active = activeOperation("collect-task-predecessor");
    const order: string[] = [];
    const dispatch = async (run: ReturnType<typeof source>) => {
      order.push(run.prompt);
    };
    const before = source("before task");
    const native = source("native task payload");
    const after = source("after task");
    const settings = { mode: "collect" as const, debounceMs: 0 };
    for (const run of [before, native, after]) {
      expect(enqueueFollowupRun(key, run, settings, "none", dispatch)).toBe(true);
      ownedInputs.push(run.controllerInput!);
    }
    const input = native.controllerInput!;
    const task = claimSessionControllerTask(input, () => {
      order.push("native task");
    });
    // Observe early rejection; awaiting task below still fails the test.
    void task.catch(() => {});
    expect(order).toEqual([]);
    active.complete();
    const taskClaim = await task;
    expect(order).toEqual(["before task", "native task"]);
    await releaseClaim(taskClaim);
    await after.controllerInput!.settlement.promise;
    await after.controllerInput!.claim?.settlement.promise;
    expect(order).toEqual(["before task", "native task", "after task"]);
  });
  it("does not replay a selected input when asynchronous source adoption fails", async () => {
    const run = source("do once");
    const settled = createDeferredCore();
    run.turnAdoptionLifecycle = { onAdopted: () => {}, onSettled: () => settled.resolve() };
    const dispatched = vi.fn(async () => {
      throw new Error("custody failed after side effects");
    });
    enqueueFollowupRun(key, run, { mode: "followup", debounceMs: 0 }, "none", dispatched);
    await settled.promise;
    await captureSessionControllerSourceSettlement(run.controllerInput!);
    await run.controllerInput!.claim?.settlement.promise;
    expect(findSessionControllerEntry(key)).toBeUndefined();
    expect(dispatched).toHaveBeenCalledOnce();
  });
});

it("clearFollowupQueue retains delayed native injection and source adoption until actual cleanup", async () => {
  const run = source("delayed native input");
  const adopted = createDeferredCore();
  const settled = vi.fn();
  run.turnAdoptionLifecycle = { onAdopted: () => adopted.promise, onSettled: settled };
  const reservation = reserveSteerCandidate(
    key,
    run,
    { mode: "steer", debounceMs: 0 },
    async () => {},
  );
  assert(reservation, "Missing injection reservation");
  expect(await reservation.admit()).toBe("steer");
  const input = run.controllerInput;
  assert(input, "Missing source input");
  const injection = input.injection;
  const adoption = admitFollowupRunLifecycle(run);
  clearFollowupQueue(key);
  expect(input.mailbox.entries).toContain(input);
  expect(input.injection).toBe(injection);
  expect(injection?.accepted).toBeUndefined();
  expect(settled).not.toHaveBeenCalled();
  reservation.accepted(true);
  reservation.consume("consumed");
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(input.mailbox.entries).toContain(input);
  adopted.resolve();
  await adoption;
  await captureSessionControllerSourceSettlement(input);
  expect(settled).toHaveBeenCalledOnce();
  expect(input.mailbox.entries).not.toContain(input);
});

function earlySource(adapter?: Parameters<typeof reserveSessionControllerSource>[1]["adapter"]) {
  return reserveSource({
    protocolRunId: " exact source ",
    adapter,
  });
}

describe("early source injection custody", () => {
  it("lets a steer inject behind an older source committed to a later turn", async () => {
    const settings = { mode: "steer" as const, debounceMs: 0 };
    const older = source("queued for the next turn");
    const newer = source("steer the current turn");
    expect(enqueueFollowupRun(key, older, settings, "none", async () => {}, false)).toBe(true);
    const steer = reserveSteerCandidate(key, newer, settings, async () => {});
    expect(steer).toBeDefined();
    await expect(steer?.admit()).resolves.toBe("steer");
    steer?.fallback();
  });

  it.each([false, true])("preserves injection FIFO with interrupt=%s", async (withInterrupt) => {
    const first = earlySource();
    const interrupt = withInterrupt ? interruptSource(" interrupt ") : undefined;
    const last = earlySource();
    const c = inject(last);
    const { admitted, pending } = observeAdmission(c);
    const b = interrupt && inject(interrupt);
    const a = inject(first);
    if (b) {
      await expect(b.admit()).resolves.toBe(true);
      b.finish(false);
      await Promise.resolve();
      expect(admitted).not.toHaveBeenCalled();
    }
    await expect(a.admit()).resolves.toBe(true);
    expect(admitted).not.toHaveBeenCalled();
    a.finish(false);
    if (!b) {
      await expect(inject(first).admit()).resolves.toBe(false);
    }
    await expect(pending).resolves.toBe(true);
  });

  it("claims an earlier source while a later injection awaits its reservation", async () => {
    const first = earlySource();
    const second = earlySource();
    const injection = inject(second);
    const { admitted, pending } = observeAdmission(injection);
    expect(admitted).not.toHaveBeenCalled();
    const claim = tryClaimSessionControllerTask(first);
    expect(claim?.inputs).toEqual([first]);
    expect(first.mailbox.claim).toBe(claim);
    await expect(pending).resolves.toBe(true);
    expect(first.claim).toBe(claim);
    expect([first.phase, second.phase]).toEqual(["claimed", "injecting"]);
    expect(admitted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("serializes exact attempts through outcome, without synthesizing FollowupRun", async () => {
    const first = earlySource();
    const second = earlySource();
    const a = inject(first);
    const b = inject(second);
    expect(await a.admit()).toBe(true);
    expect(first.source).toBeUndefined();
    expect(await a.admit()).toBe(false);
    expect(await inject(first).admit()).toBe(false);
    const { admitted, pending: next } = observeAdmission(b);
    a.accepted(true);
    a.accepted(false);
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    await expect(claimSessionControllerTask(first, () => {})).rejects.toThrow(/injection/);
    // Acceptance wins even if a late caller mistakes the outcome for rejection.
    a.finish(false);
    expect(await next).toBe(true);
    expect([first.phase, second.phase]).toEqual(["consumed", "injecting"]);
    // Old callbacks must not consume a same-ID sibling.
    a.accepted(true);
    a.finish(true);
    expect(second.abortSignal.aborted).toBe(false);
    b.accepted(false);
    b.finish(false);
    const claim = await claimSessionControllerTask(second, () => {});
    expect(claim.inputs).toEqual([second]);
  });

  it("keeps uncertain cancelled native work until finish and joins source cleanup", async () => {
    const cleanup = createDeferredCore();
    const cancel = vi.fn();
    const settled = vi.fn(() => cleanup.promise);
    const input = earlySource({ cancel, onSettled: settled });
    const injection = inject(input);
    expect(await injection.admit()).toBe(true);
    const reason = createAgentRunRestartAbortError();
    expect(abortSessionControllerInput(input, reason)).toBe(true);
    expect(abortSessionControllerInput(input, reason)).toBe(false);
    injection.accepted(false);
    expect(input.phase).toBe("injecting");
    expect(settled).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    const receipt = captureSessionControllerSourceSettlement(input);
    const completed = vi.fn();
    void receipt.then(completed);
    injection.finish(true); // Native rejection is indeterminate, not safe replay.
    expect(settled).toHaveBeenCalledOnce();
    expect(input.mailbox.entries).toContain(input);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    cleanup.resolve();
    await receipt;
    expect(input.mailbox.entries).not.toContain(input);
    expect(await inject(input).admit()).toBe(false);
  });

  it.each(["revoked", "cancelled"] as const)(
    "settles a %s waiting injection without consuming its predecessor",
    async (outcome) => {
      const first = earlySource();
      const authority = revocableAuthority("source revoked");
      const second = earlySource({ authority: authority.authority });
      if (outcome === "revoked") {
        const hold = holdSessionControllerSourceWithdrawal(second);
        expect(await inject(second).admit()).toBe(false);
        expect(second.phase).toBe("preparing");
        hold.release();
      }
      const a = inject(first);
      expect(await a.admit()).toBe(true);
      const b = inject(second);
      const admission = b.admit();
      if (outcome === "revoked") {
        const rejected = expect(admission).rejects.toThrow("source revoked");
        authority.revoke();
        a.finish(true);
        await rejected;
        expect(second.injection).toBeUndefined();
      } else {
        abortSessionControllerInput(second, "stop");
        expect(await admission).toBe(false);
      }
      await captureSessionControllerSourceSettlement(second);
      if (outcome === "revoked") {
        expect(second.phase).toBe("consumed");
        expect(await inject(second).admit()).toBe(false);
      } else {
        expect(first).toMatchObject({ phase: "injecting", abortSignal: { aborted: false } });
        a.finish(true);
      }
    },
  );
});

describe("committed source withdrawal", () => {
  it("commits after revocation and retirement without touching a same-ID successor", async () => {
    const authority = new AbortController();
    const cancel = vi.fn();
    const input = earlySource({
      authority: {
        signal: authority.signal,
        assertCurrent: () => authority.signal.throwIfAborted(),
      },
      cancel,
    });
    const hold = holdSessionControllerSourceWithdrawal(input);
    expect(() => holdSessionControllerSourceWithdrawal(input)).toThrow(/unavailable/);
    const selected = vi.fn();
    const queued = claimSessionControllerTask(input, selected);
    const revoked = new Error("execution authority revoked by committed publication");
    const rejected = expect(queued).rejects.toBe(revoked);
    // Publication of the successful DB discard may revoke admission authority
    // and remove protocol correlation before its await resumes.
    authority.abort(revoked);
    retireSessionControllerInput(input);
    const successor = earlySource();
    const discarded = new Error("committed discard");
    cancel.mockImplementation(() => {
      expect(hold.commit(discarded)).toBe(false);
      hold.release();
      expect(selected).not.toHaveBeenCalled();
    });
    expect(input.mailbox.entries).toContain(input);
    expect(hold.commit(discarded)).toBe(true);
    expect(hold.commit(discarded)).toBe(false);
    await rejected;
    await captureSessionControllerSourceSettlement(input);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(discarded);
    expect(input.withdrawalHolds).toBe(0);
    expect(selected).not.toHaveBeenCalled();
    expect(successor).toMatchObject({ phase: "preparing", abortSignal: { aborted: false } });
  });

  it("releases a failed discard back to the same usable source", async () => {
    const input = earlySource();
    const hold = holdSessionControllerSourceWithdrawal(input);
    const selected = vi.fn();
    const pending = claimSessionControllerTask(input, selected);
    expect(selected).not.toHaveBeenCalled();
    expect(() =>
      hold.cancel(() => {
        throw new Error("DB precommit refused");
      }),
    ).toThrow(/refused/);
    hold();
    hold.release();
    const claim = await pending;
    expect(claim.inputs).toEqual([input]);
    expect(input.abortSignal.aborted).toBe(false);
    expect(hold.commit("late callback")).toBe(false);
    expect(selected).toHaveBeenCalledOnce();
  });
});

describe("exact source cancellation authority", () => {
  it.each([
    ["restart", () => createAgentRunRestartAbortError()],
    ["timeout", () => new DOMException("execution deadline", "TimeoutError")],
    [
      "watchdog cause",
      () => new Error("stalled attempt", { cause: new Error("watchdog evidence") }),
    ],
    ["user", () => new Error("user stop")],
  ] as const)(
    "preserves %s and cancels operation/source exactly once under requester authority",
    async (_label, createReason) => {
      const authority = revocableAuthority("original operator revoked");
      const cancelSource = vi.fn();
      const input = earlySource({
        authority: authority.authority,
        cancel: cancelSource,
      });
      const claim = await claimSessionControllerTask(input, () => {});
      const operation = activeOperation("causal-operation", {
        mailboxClaim: claim,
        upstreamAbortSignal: claim.abortController.signal,
      });
      operation.setPhase("running");
      const cancelBackend = vi.fn(() => {
        expect(abortSessionControllerInput(input, "reentrant")).toBe(false);
      });
      operation.attachBackend({ kind: "embedded", cancel: cancelBackend });
      authority.revoke();
      const reason = createReason();
      expect(() =>
        abortSessionControllerInput(input, reason, () => {
          throw new Error("requester revoked");
        }),
      ).toThrow("requester revoked");
      expect(cancelBackend).not.toHaveBeenCalled();
      expect(abortSessionControllerInput(input, reason, () => {})).toBe(true);
      expect(operation.abortSignal.reason).toBe(reason);
      expect(input.abortSignal.reason).toBe(reason);
      expect(claim.abortController.signal.reason).toBe(reason);
      expect(cancelBackend).toHaveBeenCalledOnce();
      expect(cancelSource).toHaveBeenCalledExactlyOnceWith(reason);
      expect(abortSessionControllerInput(input, reason)).toBe(false);
      expect(input.mailbox.entries).toContain(input);
    },
  );

  it("refuses new abort effects for frozen operation outcomes", async () => {
    const cancel = vi.fn();
    const input = earlySource({ cancel });
    const claim = await claimSessionControllerTask(input, () => {});
    const operation = activeOperation("finishing", { mailboxClaim: claim });
    operation.freezeAbort();
    expect(abortSessionControllerInput(input, "stop")).toBe(false);
    expect(input.abortSignal.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });
});
