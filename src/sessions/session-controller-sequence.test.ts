import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  controllerGate as gate,
  controllerSource as reserve,
  controllerTarget,
  controllerTurn as turn,
} from "./controller-core.test-support.js";
import { withSessionTurn } from "./session-controller.admission.js";
import type { ReplyBackendHandle, ReplyOperation } from "./session-controller.contracts.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerClaim,
  runSessionMutation,
} from "./session-controller.lifecycle.js";
import {
  holdSessionControllerSourceWithdrawal,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
} from "./session-controller.mailbox.js";
import { getSessionControllerOperation } from "./session-controller.state.js";

type Native = EmbeddedAgentQueueHandle & ReplyBackendHandle;
function nativeHandle(cancel: () => void): Native {
  return {
    kind: "embedded",
    runId: "same-native-id",
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: cancel,
    cancel,
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing sequence fixture");
  }
  return value;
}
const targetFor = (name: string) => controllerTarget("sequence.sqlite", "agent:main:" + name, name);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["owner-first", "source-first"] as const)(
  "keeps a mutation and successor behind raw cleanup receipts (%s)",
  async (order) => {
    const target = targetFor(order);
    const execution = gate();
    const rawOwner = createDeferredCore();
    const sourceStarted = vi.fn();
    const sourceCleanup = gate(sourceStarted);
    const mutationStarted = vi.fn();
    const mutationGate = gate(mutationStarted);
    const input = reserve(target, { adapter: { onSettled: sourceCleanup.run } });
    const next = vi.fn(async () => {});
    let owner: ReplyOperation | undefined;
    const first = withSessionTurn(
      { ...turn(target), controllerInput: input },
      async (operation) => {
        owner = required(operation);
        const handle = nativeHandle(() => {});
        attachActiveEmbeddedRun(
          target.incarnation!,
          handle,
          target.sessionKey,
          undefined,
          "main",
          owner,
        );
        await execution.run();
        detachActiveEmbeddedRun(target.incarnation!, handle);
        void rawOwner.promise.then(owner.retainExecution());
        owner.complete();
      },
    );
    await execution.entered;
    const successor = withSessionTurn(turn(target), next);
    execution.release();
    await vi.advanceTimersByTimeAsync(0);
    const mutation = runSessionMutation({ target, policy: "wait", run: mutationGate.run });
    try {
      if (order === "owner-first") {
        rawOwner.resolve();
      } else {
        sourceCleanup.release();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(sourceStarted).toHaveBeenCalledTimes(order === "owner-first" ? 1 : 0);
      expect(next).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(target.sessionKey, target)).toBe(
        order === "owner-first" ? undefined : owner,
      );
      expect(mutationStarted).not.toHaveBeenCalled();
      rawOwner.resolve();
      sourceCleanup.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(sourceStarted).toHaveBeenCalledOnce();
      expect(mutationStarted).toHaveBeenCalledOnce();
      expect(next).not.toHaveBeenCalled();
      mutationGate.release();
      await Promise.all([first, input.settlement.promise, mutation, successor]);
      expect(next).toHaveBeenCalledOnce();
    } finally {
      execution.release();
      rawOwner.resolve();
      sourceCleanup.release();
      mutationGate.release();
      owner?.complete();
      await Promise.allSettled([first, mutation, successor]);
    }
  },
);

it("joins sources withdrawn after a mutation captured its cleanup receipts", async () => {
  const target = targetFor("late-withdrawal");
  const active = gate();
  const cleanupStarted = [vi.fn(), vi.fn()];
  const cleanups = cleanupStarted.map((started) => gate(started));
  const predecessor = withSessionTurn(turn(target), active.run);
  await active.entered;
  const inputs = [reserve(target, { adapter: { onSettled: cleanups[0]!.run } })];
  const holds = [holdSessionControllerSourceWithdrawal(inputs[0]!)];
  const run = vi.fn(async () => {});
  const mutation = runSessionMutation({ target, policy: "wait", run });
  try {
    expect(holds[0]!.commit()).toBe(true);
    active.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanupStarted[0]).toHaveBeenCalledOnce();
    inputs.push(reserve(target, { adapter: { onSettled: cleanups[1]!.run } }));
    const second = holdSessionControllerSourceWithdrawal(inputs[1]!);
    holds.push(second);
    expect(second.commit()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanupStarted[1]).toHaveBeenCalledOnce();
    cleanups[0]!.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    cleanups[1]!.release();
    await Promise.all([predecessor, mutation, ...inputs.map((input) => input.settlement.promise)]);
    expect(run).toHaveBeenCalledOnce();
  } finally {
    active.release();
    cleanups.forEach((cleanup) => cleanup.release());
    holds.forEach((hold) => hold.commit());
    await Promise.allSettled([predecessor, mutation]);
  }
});

it("borrows the admitted native turn inside a mutation without admitting its queued competitor", async () => {
  const key = "agent:main:sequence-borrow";
  const sessionId = "sequence-borrow";
  const target = captureSessionTarget({
    storeScope: "sequence.sqlite",
    sessionKey: key,
    incarnation: sessionId,
  });
  const entered = createDeferredCore();
  const mutate = createDeferredCore();
  const borrowed = createDeferredCore();
  const leaveMutation = createDeferredCore();
  const finish = createDeferredCore();
  const abort = new AbortController();
  const order: string[] = [];
  let competitor: Promise<void> | undefined;
  let owner: ReplyOperation | undefined;
  let claim: SessionControllerMailboxClaim | undefined;
  const first = withSessionTurn({ sessionKey: key, sessionId, target }, async (operation) => {
    owner = required(operation);
    claim = getCurrentSessionControllerClaim();
    entered.resolve();
    await mutate.promise;
    await runSessionMutation({
      target,
      policy: "wait",
      run: async () => {
        order.push("mutation");
        await withSessionTurn({ sessionKey: key, sessionId, target }, async (nested) => {
          expect(nested).toBe(operation);
          order.push("borrowed");
        });
        borrowed.resolve();
        await leaveMutation.promise;
      },
    });
    order.push("mutation-released");
    await finish.promise;
  });
  void first.catch(() => {});
  try {
    await entered.promise;
    // Request outside the owner's async context: matching IDs cannot borrow it.
    competitor = withSessionTurn(
      { sessionKey: key, sessionId, target, abortSignal: abort.signal },
      async () => {
        order.push("competitor");
      },
    );
    void competitor.catch(() => {});
    mutate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["mutation", "borrowed"]);
    await borrowed.promise;
    leaveMutation.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["mutation", "borrowed", "mutation-released"]);
    finish.resolve();
    await Promise.all([first, competitor]);
    expect(order).toEqual(["mutation", "borrowed", "mutation-released", "competitor"]);
  } finally {
    abort.abort();
    mutate.resolve();
    leaveMutation.resolve();
    finish.resolve();
    // Unwind a self-wait regression too, preserving the assertion failure.
    owner?.complete();
    if (claim) {
      releaseSessionControllerClaim(claim);
    }
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled([first, ...(competitor ? [competitor] : [])]);
  }
});
