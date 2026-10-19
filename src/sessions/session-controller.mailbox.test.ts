import { afterEach, describe, expect, it, vi } from "vitest";
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
  reserveOrJoinSessionControllerSource,
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
afterEach(() => {
  findSessionControllerEntry(key)?.active?.complete();
  clearFollowupQueue(key);
  vi.useRealTimers();
});
function source(prompt: string) {
  const run = createQueueTestRun({ prompt });
  run.run.sessionKey = key;
  return run;
}

describe("controller mailbox scheduling", () => {
  it("drains a re-enqueued incognito followup from its original owner", async () => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:dashboard:incognito-recovery-mailbox";
    const sessionId = "incognito-recovery-session";
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
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
    try {
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
      scheduleFollowupDrain(sessionKey, dispatch, owner);
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered).toEqual([]);
      active.complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered).toEqual(["Deliver the missing source reply."]);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      active.complete();
      if (retry.controllerInput) {
        retireSessionControllerInput(retry.controllerInput);
        await retry.controllerInput.settlement.promise;
        await retry.controllerInput.claim?.settlement.promise;
      }
    }
  });

  it("restores the selected pre-execution claim after its exact predecessor settles", async () => {
    const selected = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
    const selectedClaim = tryClaimSessionControllerTask(selected);
    expect(selectedClaim).toBeDefined();
    if (!selectedClaim) {
      throw new Error("expected selected source claim");
    }
    const predecessor = reserveSessionControllerClaimPredecessor(selectedClaim, {
      policy: { mode: "followup" },
    });

    expect(selected.mailbox.claim).toBeUndefined();
    expect(selected.mailbox.entries).toEqual([predecessor.input, selected]);
    expect(selected.phase).toBe("claimed");

    const predecessorClaim = await claimSessionControllerTask(predecessor.input, () => {});
    releaseSessionControllerClaim(predecessorClaim);
    await predecessorClaim.settlement.promise;

    await expect(predecessor.restored).resolves.toBe(true);
    expect(selected.mailbox.claim).toBe(selectedClaim);
    expect(selected.claim).toBe(selectedClaim);
    expect(selected.phase).toBe("claimed");

    releaseSessionControllerClaim(selectedClaim);
    await selectedClaim.settlement.promise;
  });

  it("keeps later injection behind a preparing tail after joining a recovery predecessor", async () => {
    const selected = earlySource();
    const selectedClaim = tryClaimSessionControllerTask(selected);
    if (!selectedClaim) {
      throw new Error("expected selected source claim");
    }
    const recovery = {
      reservationId: "owed:joined-predecessor",
      policy: { mode: "followup" as const },
    };
    const existing = reserveSessionControllerSource(key, recovery);
    const tail = earlySource();
    const predecessor = reserveSessionControllerClaimPredecessor(selectedClaim, recovery);
    expect(predecessor.created).toBe(false);
    expect(predecessor.input).toBe(existing);
    const predecessorClaim = await claimSessionControllerTask(existing, () => {});
    const later = earlySource();
    const laterInjection = beginSessionControllerSourceInjection(later);
    const admittedLater = vi.fn();
    const laterAdmission = laterInjection.admit().then((admitted) => {
      admittedLater(admitted);
      return admitted;
    });
    const tailInjection = beginSessionControllerSourceInjection(tail);
    const tailAdmission = tailInjection.admit();
    try {
      await expect(tailAdmission).resolves.toBe(true);
      expect(admittedLater).not.toHaveBeenCalled();
      tailInjection.finish(false);
      await expect(laterAdmission).resolves.toBe(true);
    } finally {
      tailInjection.finish(false);
      laterInjection.finish(false);
      releaseSessionControllerClaim(predecessorClaim);
      await predecessorClaim.settlement.promise;
      await predecessor.restored;
      releaseSessionControllerClaim(selectedClaim);
      retireSessionControllerInput(tail);
      retireSessionControllerInput(later);
      await Promise.allSettled([
        tailAdmission,
        laterAdmission,
        selectedClaim.settlement.promise,
        tail.settlement.promise,
        later.settlement.promise,
      ]);
    }
  });

  it("does not restore a selected claim cancelled during its predecessor", async () => {
    const cancelled = new AbortController();
    const selected = reserveSessionControllerSource(key, {
      policy: { mode: "followup" },
      adapter: { signal: cancelled.signal },
    });
    const selectedClaim = tryClaimSessionControllerTask(selected);
    expect(selectedClaim).toBeDefined();
    if (!selectedClaim) {
      throw new Error("expected selected source claim");
    }
    const predecessor = reserveSessionControllerClaimPredecessor(selectedClaim, {
      policy: { mode: "followup" },
    });

    cancelled.abort(new Error("cancel selected source"));
    await expect(predecessor.restored).resolves.toBe(false);
    // Aborted admission returns its claim before independent recovery can run.
    releaseSessionControllerClaim(selectedClaim);
    await selectedClaim.settlement.promise;
    const predecessorClaim = await claimSessionControllerTask(predecessor.input, () => {});
    releaseSessionControllerClaim(predecessorClaim);
    await predecessorClaim.settlement.promise;

    expect(selected.mailbox.claim).not.toBe(selectedClaim);
    expect(selected.retirementRequested).toBe(true);
  });

  it("preserves a later interrupt before restoring the selected claim", async () => {
    const selected = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
    const selectedClaim = tryClaimSessionControllerTask(selected);
    expect(selectedClaim).toBeDefined();
    if (!selectedClaim) {
      throw new Error("expected selected source claim");
    }
    const predecessor = reserveSessionControllerClaimPredecessor(selectedClaim, {
      policy: { mode: "followup" },
    });
    const predecessorClaim = await claimSessionControllerTask(predecessor.input, () => {});
    const interrupt = reserveSessionControllerSource(key, { policy: { mode: "interrupt" } });
    const interruptClaim = claimSessionControllerTask(interrupt, () => {});

    releaseSessionControllerClaim(predecessorClaim);
    await predecessorClaim.settlement.promise;
    const priorityClaim = await interruptClaim;

    expect(selected.mailbox.claim).toBe(priorityClaim);
    expect(selected.mailbox.claim).not.toBe(selectedClaim);

    releaseSessionControllerClaim(priorityClaim);
    await priorityClaim.settlement.promise;
    await expect(predecessor.restored).resolves.toBe(true);
    expect(selected.mailbox.claim).toBe(selectedClaim);

    releaseSessionControllerClaim(selectedClaim);
    await selectedClaim.settlement.promise;
  });

  it.each(["ready", "task"] as const)(
    "releases the consumed %s callback before a source retry",
    async (kind) => {
      const input = reserveSessionControllerSource(key, { policy: { mode: "followup" } });
      const run = source("retry after preflight refusal");
      bindSessionControllerSource(input, run);
      const request = () =>
        kind === "ready"
          ? claimSessionControllerInput(run)
          : claimSessionControllerTask(input, () => {});
      try {
        const first = await request();
        expect(deferSessionControllerClaimBeforeExecution(first)).toBe(true);
        releaseSessionControllerClaim(first);
        await first.settlement.promise;
        expect(input.mailbox.claim).toBeUndefined();
        const retried = await request();
        expect(retried).not.toBe(first);
        expect(retried.inputs).toContain(input);
        releaseSessionControllerClaim(retried);
        await retried.settlement.promise;
      } finally {
        const remaining = input.mailbox.claim;
        if (remaining) {
          releaseSessionControllerClaim(remaining);
          await remaining.settlement.promise;
        }
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
    },
  );
  it("runs reserved start callbacks on claim in FIFO order, never again for a joined reservation", async () => {
    const active = createReplyOperation({
      sessionKey: key,
      sessionId: "start-callback-active",
      resetTriggered: false,
    });
    active.setPhase("running");
    const started: string[] = [];
    const reserve = (id: string, reservationId?: string) =>
      reserveOrJoinSessionControllerSource(key, {
        reservationId,
        policy: { mode: "followup" },
        start: (claim) => {
          started.push(id);
          void Promise.resolve().then(() => releaseSessionControllerClaim(claim));
        },
      });
    const first = reserve("first", "owed:first");
    const second = reserve("second");
    expect(reserve("joined", "owed:first")).toEqual({ input: first.input, created: false });
    expect(started).toEqual([]);

    active.complete();
    await first.input.settlement.promise;
    await second.input.settlement.promise;

    expect(first.created && second.created).toBe(true);
    expect(started).toEqual(["first", "second"]);
  });
  it("retires a queued injection before releasing its receipt when live authority rejects", async () => {
    const active = createReplyOperation({
      sessionKey: key,
      sessionId: "active",
      resetTriggered: false,
    });
    let revoked = false;
    const input = reserveSessionControllerSource(key, {
      policy: { mode: "followup", debounceMs: 0 },
      adapter: {
        authority: {
          assertCurrent: () => {
            if (revoked) {
              active.complete();
              throw new Error("source authority revoked");
            }
          },
        },
      },
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
    expect(injection).toBeDefined();
    revoked = true;
    await expect(injection?.admit()).rejects.toThrow("source authority revoked");
    await captureSessionControllerSourceSettlement(input);
    expect(dispatch).not.toHaveBeenCalled();
    expect(findSessionControllerEntry(key)).toBeUndefined();
  });
  it("reserves interrupt D before A settles, then keeps B,C in original order", async () => {
    const a = createReplyOperation({ sessionKey: key, sessionId: "a", resetTriggered: false });
    const order: string[] = [];
    const drained = createDeferredCore();
    const dispatch = async (run: ReturnType<typeof source>) => {
      order.push(run.prompt);
      if (run.prompt === "C") {
        drained.resolve();
      }
    };
    enqueueFollowupRun(key, source("B"), { mode: "followup", debounceMs: 0 }, "none", dispatch);
    enqueueFollowupRun(key, source("C"), { mode: "followup", debounceMs: 0 }, "none", dispatch);
    const d = reserveSessionControllerSource(key, {
      protocolRunId: " D ",
      policy: { mode: "interrupt" },
    });
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
  });
  it("canceling an older priority never clears the newest interrupt reservation", async () => {
    const first = reserveSessionControllerSource(key, {
      protocolRunId: "old",
      policy: { mode: "interrupt" },
    });
    const newest = reserveSessionControllerSource(key, {
      protocolRunId: "new",
      policy: { mode: "interrupt" },
    });
    retireSessionControllerInput(first);
    expect(getExistingSessionControllerMailbox(key)?.priority).toBe(newest);
    const run = source("new");
    bindSessionControllerSource(newest, run);
    const claim = await claimSessionControllerInput(run);
    expect(claim.inputs).toEqual([newest]);
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
    expect(Boolean(findSessionControllerEntry(key))).toBe(false);
  });
  it("preserves exact protocol identities and withdrawal custody before payload exists", () => {
    const cancel = vi.fn();
    const input = reserveSessionControllerSource(key, {
      protocolRunId: " id ",
      policy: { mode: "followup" },
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
    const active = createReplyOperation({
      sessionKey: key,
      sessionId: "collect-task-predecessor",
      resetTriggered: false,
    });
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
    }
    const input = native.controllerInput!;
    const task = claimSessionControllerTask(input, () => {
      order.push("native task");
    });
    // Observe rejection before releasing the predecessor so a lost task cannot leak a rejection.
    const selected = task.then(
      (claim) => ({ ok: true as const, claim }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let taskClaim: Awaited<typeof task> | undefined;
    try {
      expect(order).toEqual([]);
      active.complete();
      const result = await selected;
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw result.error;
      }
      taskClaim = result.claim;
      expect(order).toEqual(["before task", "native task"]);
      releaseSessionControllerClaim(taskClaim);
      await taskClaim.settlement.promise;
      await after.controllerInput!.settlement.promise;
      await after.controllerInput!.claim?.settlement.promise;
      expect(order).toEqual(["before task", "native task", "after task"]);
    } finally {
      active.complete();
      if (taskClaim) {
        releaseSessionControllerClaim(taskClaim);
        await taskClaim.settlement.promise;
      }
      clearFollowupQueue(key);
      await Promise.allSettled(
        [before, native, after].map((run) => run.controllerInput!.settlement.promise),
      );
      await selected;
    }
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
  expect(reservation).toBeDefined();
  if (!reservation) {
    throw new Error("Missing injection reservation");
  }
  expect(await reservation.admit()).toBe("steer");
  const input = run.controllerInput;
  if (!input) {
    throw new Error("Missing source input");
  }
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
  return reserveSessionControllerSource(key, {
    protocolRunId: " exact source ",
    policy: { mode: "followup" },
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

  it("keeps injection FIFO when an older reservation is still preparing", async () => {
    const first = earlySource();
    const second = earlySource();
    const b = beginSessionControllerSourceInjection(second);
    const admittedSecond = vi.fn();
    const secondAdmission = b.admit().then((admitted) => {
      admittedSecond(admitted);
      return admitted;
    });
    const a = beginSessionControllerSourceInjection(first);
    const firstAdmission = a.admit();
    try {
      await expect(
        Promise.race([firstAdmission.then(() => "first"), secondAdmission.then(() => "second")]),
      ).resolves.toBe("first");
      await expect(firstAdmission).resolves.toBe(true);
      expect(admittedSecond).not.toHaveBeenCalled();
      a.finish(false);
      await expect(beginSessionControllerSourceInjection(first).admit()).resolves.toBe(false);
      await expect(secondAdmission).resolves.toBe(true);
    } finally {
      a.finish(false);
      b.finish(false);
      await Promise.allSettled([firstAdmission, secondAdmission]);
      retireSessionControllerInput(first);
      retireSessionControllerInput(second);
    }
  });

  it("claims an earlier source while a later injection awaits its reservation", async () => {
    const first = earlySource();
    const second = earlySource();
    const injection = beginSessionControllerSourceInjection(second);
    const admitted = vi.fn();
    const pending = injection.admit().then((value) => {
      admitted(value);
      return value;
    });
    let claim: ReturnType<typeof tryClaimSessionControllerTask>;
    try {
      expect(admitted).not.toHaveBeenCalled();
      claim = tryClaimSessionControllerTask(first);
      expect(claim?.inputs).toEqual([first]);
      expect(first.mailbox.claim).toBe(claim);
      await expect(pending).resolves.toBe(true);
      expect(first.claim).toBe(claim);
      expect(first.phase).toBe("claimed");
      expect(second.phase).toBe("injecting");
      expect(admitted).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      injection.finish(false);
      if (claim) {
        releaseSessionControllerClaim(claim);
      }
      retireSessionControllerInput(first);
      retireSessionControllerInput(second);
      await Promise.allSettled([pending, first.settlement.promise, second.settlement.promise]);
    }
  });

  it("keeps a later source behind older reservations when an interrupt bypasses them", async () => {
    const first = earlySource();
    const interrupt = reserveSessionControllerSource(key, {
      protocolRunId: " interrupt ",
      policy: { mode: "interrupt" },
    });
    const last = earlySource();
    const c = beginSessionControllerSourceInjection(last);
    const admittedLast = vi.fn();
    const lastAdmission = c.admit().then((admitted) => {
      admittedLast(admitted);
      return admitted;
    });
    const b = beginSessionControllerSourceInjection(interrupt);
    const a = beginSessionControllerSourceInjection(first);
    try {
      await expect(b.admit()).resolves.toBe(true);
      b.finish(false);
      await Promise.resolve();
      expect(admittedLast).not.toHaveBeenCalled();
      await expect(a.admit()).resolves.toBe(true);
      a.finish(false);
      await expect(lastAdmission).resolves.toBe(true);
    } finally {
      a.finish(false);
      b.finish(false);
      c.finish(false);
      await Promise.allSettled([lastAdmission]);
      retireSessionControllerInput(first);
      retireSessionControllerInput(interrupt);
      retireSessionControllerInput(last);
    }
  });

  it("serializes exact attempts through outcome, without synthesizing FollowupRun", async () => {
    const first = earlySource();
    const second = earlySource();
    const a = beginSessionControllerSourceInjection(first);
    const b = beginSessionControllerSourceInjection(second);
    expect(await a.admit()).toBe(true);
    expect(first.source).toBeUndefined();
    expect(await a.admit()).toBe(false);
    expect(await beginSessionControllerSourceInjection(first).admit()).toBe(false);
    const admitted = vi.fn();
    const next = b.admit().then((value) => {
      admitted(value);
      return value;
    });
    a.accepted(true);
    a.accepted(false);
    await Promise.resolve();
    expect(admitted).not.toHaveBeenCalled();
    await expect(claimSessionControllerTask(first, () => {})).rejects.toThrow(/injection/);
    // Acceptance wins even if a late caller mistakes the outcome for rejection.
    a.finish(false);
    expect(await next).toBe(true);
    expect(first.phase).toBe("consumed");
    expect(second.phase).toBe("injecting");
    // Old callbacks must not consume a same-ID sibling.
    a.accepted(true);
    a.finish(true);
    expect(second.abortSignal.aborted).toBe(false);
    b.accepted(false);
    b.finish(false);
    const claim = await claimSessionControllerTask(second, () => {});
    expect(claim.inputs).toEqual([second]);
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  });

  it("keeps uncertain cancelled native work until finish and joins source cleanup", async () => {
    const cleanup = createDeferredCore();
    const cancel = vi.fn();
    const settled = vi.fn(() => cleanup.promise);
    const input = earlySource({ cancel, onSettled: settled });
    const injection = beginSessionControllerSourceInjection(input);
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
    expect(await beginSessionControllerSourceInjection(input).admit()).toBe(false);
  });

  it("rejects held withdrawal and rechecks source authority after its predecessor", async () => {
    const first = earlySource();
    let current = true;
    const second = earlySource({
      authority: {
        assertCurrent() {
          if (!current) {
            throw new Error("source revoked");
          }
        },
      },
    });
    const hold = holdSessionControllerSourceWithdrawal(second);
    expect(await beginSessionControllerSourceInjection(second).admit()).toBe(false);
    expect(second.phase).toBe("preparing");
    hold.release();
    const a = beginSessionControllerSourceInjection(first);
    expect(await a.admit()).toBe(true);
    const b = beginSessionControllerSourceInjection(second);
    const pending = expect(b.admit()).rejects.toThrow("source revoked");
    current = false;
    a.finish(true);
    await pending;
    expect(second.injection).toBeUndefined();
    await captureSessionControllerSourceSettlement(second);
    expect(second.phase).toBe("consumed");
    expect(await beginSessionControllerSourceInjection(second).admit()).toBe(false);
  });

  it("cancels a not-yet-admitted attempt without releasing its predecessor", async () => {
    const first = earlySource();
    const second = earlySource();
    const a = beginSessionControllerSourceInjection(first);
    expect(await a.admit()).toBe(true);
    const b = beginSessionControllerSourceInjection(second);
    const pending = b.admit();
    abortSessionControllerInput(second, "stop");
    expect(await pending).toBe(false);
    await captureSessionControllerSourceSettlement(second);
    expect(first.phase).toBe("injecting");
    expect(first.abortSignal.aborted).toBe(false);
    a.finish(true);
  });
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
    expect(successor.phase).toBe("preparing");
    expect(successor.abortSignal.aborted).toBe(false);
    retireSessionControllerInput(successor);
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
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
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
      let current = true;
      const cancelSource = vi.fn();
      const input = earlySource({
        authority: {
          assertCurrent() {
            if (!current) {
              throw new Error("original operator revoked");
            }
          },
        },
        cancel: cancelSource,
      });
      const claim = await claimSessionControllerTask(input, () => {});
      const operation = createReplyOperation({
        sessionKey: key,
        sessionId: "causal-operation",
        resetTriggered: false,
        mailboxClaim: claim,
        upstreamAbortSignal: claim.abortController.signal,
      });
      operation.setPhase("running");
      const cancelBackend = vi.fn(() => {
        expect(abortSessionControllerInput(input, "reentrant")).toBe(false);
      });
      operation.attachBackend({ kind: "embedded", cancel: cancelBackend });
      current = false;
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
      operation.complete();
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    },
  );

  it("refuses new abort effects for frozen operation outcomes", async () => {
    const cancel = vi.fn();
    const input = earlySource({ cancel });
    const claim = await claimSessionControllerTask(input, () => {});
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "finishing",
      resetTriggered: false,
      mailboxClaim: claim,
    });
    operation.freezeAbort();
    expect(abortSessionControllerInput(input, "stop")).toBe(false);
    expect(input.abortSignal.aborted).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    operation.complete();
    releaseSessionControllerClaim(claim);
    await claim.settlement.promise;
  });
});
