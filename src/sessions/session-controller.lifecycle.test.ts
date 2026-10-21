import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "./session-controller.admission.js";
import {
  beginSessionEffect,
  bindSessionControllerTarget,
  captureSessionTarget,
  captureGatewaySessionControllerWork,
  isSessionMutationActive,
  runSessionMutation,
  SessionMutationPreemptTimeoutError,
  startSessionControllerInterruption,
  withSessionControllerOwner,
} from "./session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  trackSessionControllerSourceWork,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import { registerRpcSource } from "./session-controller.rpc-sources.js";
import type { SessionTarget } from "./session-controller.target.js";
import { onSessionLifecycleEvent, type SessionLifecycleEvent } from "./session-lifecycle-events.js";

function targetFixture(name: string, incarnation?: string) {
  return captureSessionTarget({
    storeScope: `${name}.sqlite`,
    sessionKey: `agent:main:${name}`,
    incarnation,
  });
}
function reserveSource(
  target: SessionTarget,
  options: Omit<Parameters<typeof reserveSessionControllerSource>[1], "target" | "policy"> = {},
) {
  return reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
    ...options,
  });
}
const abortAndCancel = {
  policy: "preempt",
  preempt: { activeRun: "abort", waitingInputs: "cancel" },
} as const;
const compact = {
  kind: "compaction",
  policy: "preempt",
  preempt: { activeRun: "abort-if-abortable", waitingInputs: "keep" },
} as const;
const waitOrPreempt = (policy: "wait" | "preempt") =>
  policy === "preempt" ? { kind: "reset" as const, ...abortAndCancel } : { policy };
const turnOptions = (target: SessionTarget) => ({
  target,
  sessionKey: target.sessionKey,
  sessionId: expectDefined(target.incarnation, "Expected a session incarnation"),
});
function boundOperation(target: SessionTarget, bindAtCreation = false) {
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: expectDefined(target.incarnation, "Expected a session incarnation"),
    resetTriggered: false,
    ...(bindAtCreation ? { target } : {}),
  });
  bindSessionControllerTarget(operation, target);
  return operation;
}
function pause() {
  const started = createDeferred();
  const finish = createDeferred();
  return {
    started: started.promise,
    finish: finish.resolve,
    run: async () => {
      started.resolve();
      await finish.promise;
    },
  };
}
async function abortableTurn(target: SessionTarget) {
  const started = createDeferred();
  const active = withSessionTurn(turnOptions(target), async (_operation, signal) => {
    started.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve());
    });
  });
  await started.promise;
  return { active };
}

it.each([
  ["wait", "operation"],
  ["preempt", "operation"],
  ["wait", "claim"],
  ["preempt", "claim"],
] as const)("%s mutation does not capture another incarnation's %s", async (policy, kind) => {
  vi.useFakeTimers();
  const target = targetFixture(`mutation-${policy}-${kind}`, "new");
  const old = captureSessionTarget({
    storeScope: target.storeScope,
    sessionKey: target.sessionKey,
    incarnation: "old",
  });
  const operation =
    kind === "operation"
      ? createReplyOperation({ ...turnOptions(target), resetTriggered: false })
      : undefined;
  const input = kind === "claim" ? reserveSource(target) : undefined;
  const claim = input ? await claimSessionControllerTask(input, () => {}) : undefined;
  const run = vi.fn(async () => {});
  const mutation = runSessionMutation({
    target: old,
    requiredSessionId: "old",
    ...waitOrPreempt(policy),
    run,
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(operation?.abortSignal.aborted ?? claim?.abortController.signal.aborted).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  } finally {
    operation?.complete();
    if (claim) {
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
    await mutation;
    vi.useRealTimers();
  }
});

it("captures unbound Gateway work by its source owner, not the stack that wakes it", async () => {
  const target = targetFixture("gateway-claim", "gateway-claim-id");
  const resolver = () => () => {
    throw new Error("capture must not resolve a Gateway context");
  };
  const gatewayA = resolver();
  const gatewayB = resolver();
  const firstPause = pause();
  const secondPause = pause();
  const cleanup = pause();
  const first = withPluginRuntimeGatewayContextResolver(gatewayA, () =>
    withSessionTurn({ sessionKey: target.sessionKey, target }, firstPause.run),
  );
  await firstPause.started;
  const input = withPluginRuntimeGatewayContextResolver(gatewayB, () =>
    reserveSource(target, {
      adapter: { onSettled: cleanup.run },
    }),
  );
  // Gateway A's completion wakes B's selected source before any operation exists.
  const second = withSessionTurn(
    { sessionKey: target.sessionKey, target, controllerInput: input },
    async (operation) => {
      expect(operation).toBeUndefined();
      await secondPause.run();
    },
  );
  const query = {
    scope: target.storeScope,
    sessionKey: target.sessionKey,
    sessionId: "gateway-claim-id",
  };
  try {
    firstPause.finish();
    await first;
    await secondPause.started;
    const claim = input.claim;
    if (!claim) {
      throw new Error("selected source has no claim");
    }
    const captured = captureGatewaySessionControllerWork(gatewayB);
    expect(captured.targets.get(target.storeScope)).toContain(target.sessionKey);
    expect(captured.isActive(query)).toBe(true);
    expect(captureGatewaySessionControllerWork(gatewayA).isActive(query)).toBe(false);
    secondPause.finish();
    await second;
    await cleanup.started;
    expect(captured.isActive(query)).toBe(true);
    cleanup.finish();
    await claim.settlement.promise;
    expect(captured.isActive(query)).toBe(false);
    await withPluginRuntimeGatewayContextResolver(gatewayB, () =>
      withSessionTurn({ sessionKey: target.sessionKey, target }, async () => {
        expect(captured.isActive(query)).toBe(false);
        expect(captureGatewaySessionControllerWork(gatewayB).isActive(query)).toBe(true);
      }),
    );
  } finally {
    firstPause.finish();
    secondPause.finish();
    cleanup.finish();
    await Promise.all([first, second, input.settlement.promise]);
  }
});

it.each(["reset", "compaction"] as const)(
  "%s retains a frozen owner until actual settlement",
  async (kind) => {
    const target = targetFixture("frozen-owner", "frozen-id");
    const operation = boundOperation(target, kind === "compaction");
    operation.freezeAbort();
    const prepared = createDeferred();
    const run = vi.fn(async () => {});
    const mutation = runSessionMutation({
      target,
      ...(kind === "reset" ? { kind, ...abortAndCancel } : compact),
      prepare: async () => prepared.resolve(),
      run,
    });
    try {
      await prepared.promise;
      expect(operation.abortByUser()).toBe(false);
      expect(operation.abortSignal.aborted).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect(isSessionMutationActive(target.storeScope, target.aliases)).toBe(true);
      const admitted = vi.fn();
      const effect = beginSessionEffect({ target, assertAllowed: admitted });
      await Promise.resolve();
      expect(admitted).not.toHaveBeenCalled();
      operation.complete();
      await mutation;
      (await effect).release();
      expect(run).toHaveBeenCalledOnce();
      expect(admitted).toHaveBeenCalledOnce();
    } finally {
      operation.complete();
      await mutation;
    }
  },
);

it("borrows the exact in-band owner without interrupting or awaiting its own stack", async () => {
  const target = targetFixture("own-stack", "own-id");
  const operation = boundOperation(target);
  try {
    await withSessionControllerOwner(operation, () =>
      runSessionMutation({
        target,
        kind: "reset",
        ...abortAndCancel,
        run: async () => {
          const interruption = startSessionControllerInterruption({ target });
          await interruption.released;
          expect(operation.abortSignal.aborted).toBe(false);
        },
      }),
    );
  } finally {
    operation.complete();
  }
});

it("sharing can revoke a live turn while scoped effects remain subordinate to it", async () => {
  const target = targetFixture("live-sharing", "sharing-id");
  const operation = boundOperation(target);
  const effect = await beginSessionEffect({ target, operation });
  const run = vi.fn(async () => {});
  try {
    await runSessionMutation({ target, policy: "allow-live", run });
    expect(run).toHaveBeenCalledOnce();
    expect(operation.abortSignal.aborted).toBe(false);
    expect(effect.isActive()).toBe(true);
  } finally {
    effect.release();
    operation.complete();
  }
});

it("release cannot manufacture completion while captured writer cleanup is still running", async () => {
  const target = targetFixture("retained-effect");
  const effect = await beginSessionEffect({ target });
  const writer = pause();
  const running = effect.run(writer.run);
  await writer.started;
  const interruption = startSessionControllerInterruption({ target });
  const settled = vi.fn();
  void interruption.released.then(settled);
  effect.release();
  await Promise.resolve();
  expect(effect.isActive()).toBe(false);
  expect(settled).not.toHaveBeenCalled();
  writer.finish();
  await running;
  await interruption.released;
  expect(settled).toHaveBeenCalledOnce();
});

it("joins interrupted cleanup except for the captured source handoff", async ({ signal }) => {
  const target = targetFixture("handoff-source");
  const deferredCleanup = createDeferred();
  const otherCleanup = createDeferred();
  const deferredInput = reserveSource(target);
  const otherInput = reserveSource(target);
  trackSessionControllerSourceWork(deferredInput, deferredCleanup.promise);
  trackSessionControllerSourceWork(otherInput, otherCleanup.promise);
  const deferredSettled = vi.fn();
  void deferredInput.settlement.promise.then(deferredSettled);
  const interruption = startSessionControllerInterruption({
    target,
    admissionsOnly: true,
    deferSourceSettlement: deferredInput,
  });
  const interruptedSettled = vi.fn();
  void interruption.released.then(interruptedSettled);
  try {
    expect(deferredInput.abortSignal.aborted).toBe(true);
    expect(otherInput.abortSignal.aborted).toBe(true);
    await runSessionMutation({
      target: captureSessionTarget({ ...target, storeScope: "foreign-handoff-source.sqlite" }),
      run: async () => {},
    });
    expect(interruptedSettled).not.toHaveBeenCalled();
    otherCleanup.resolve();
    await withinTest(interruption.released, signal);
    expect(deferredSettled).not.toHaveBeenCalled();
    expect(interruptedSettled).toHaveBeenCalledOnce();
  } finally {
    deferredCleanup.resolve();
    otherCleanup.resolve();
    await Promise.all([
      deferredInput.settlement.promise,
      otherInput.settlement.promise,
      interruption.released,
    ]);
  }
  expect(deferredSettled).toHaveBeenCalledOnce();
});

it("preempt interrupts a captured subordinate effect before running the mutation", async () => {
  const target = targetFixture("preempt-effect", "preempt-effect-session");
  let releaseEffect = () => {};
  const interrupted = vi.fn(() => releaseEffect());
  const effect = await beginSessionEffect({ target, onInterrupt: interrupted });
  releaseEffect = effect.release;
  const run = vi.fn(async () => {});

  await runSessionMutation({ target, kind: "reset", ...abortAndCancel, run });

  expect(interrupted).toHaveBeenCalledOnce();
  expect(effect.isActive()).toBe(false);
  expect(run).toHaveBeenCalledOnce();
});

it.each(["wait", "preempt"] as const)(
  "%s mutation joins unclaimed source cleanup without blocking a foreign store",
  async (policy) => {
    const target = targetFixture("retiring-source", "retiring-source-id");
    const cleanup = createDeferred();
    const input = reserveSource(target, {
      adapter: { onSettled: () => cleanup.promise },
    });
    retireSessionControllerInput(input);
    const run = vi.fn(async () => {});
    const mutation = runSessionMutation({ target, ...waitOrPreempt(policy), run });
    try {
      // The same mutation path in another physical store proves the scheduler progressed.
      await runSessionMutation({
        target: captureSessionTarget({ ...target, storeScope: "foreign-source.sqlite" }),
        ...waitOrPreempt(policy),
        run: async () => {},
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await input.settlement.promise;
      await mutation;
    }
    expect(run).toHaveBeenCalledOnce();
  },
);

it.each([
  ["reset", "cancel", true],
  ["delete", "cancel", false],
  ["compaction", "keep", false],
] as const)(
  "%s preemption applies its queued-input and child policy through Stop",
  async (kind, waitingInputs, stopsChildren) => {
    const target = targetFixture(`${kind}-preempt`, `${kind}-session`);
    const { active } = await abortableTurn(target);
    const firstQueued = reserveSource(target);
    const secondQueued = reserveSource(target);
    const stopChildren = vi.fn(async (applyParentStop: () => Promise<boolean>) => {
      await applyParentStop();
      return { stopped: 2, failed: 0 };
    });

    try {
      await runSessionMutation({
        target,
        kind,
        policy: "preempt",
        preempt: {
          activeRun: kind === "compaction" ? "abort-if-abortable" : "abort",
          waitingInputs,
          stopChildren: stopsChildren ? stopChildren : undefined,
        },
        run: async () => {},
      });

      expect(firstQueued.abortSignal.aborted).toBe(waitingInputs === "cancel");
      expect(secondQueued.abortSignal.aborted).toBe(waitingInputs === "cancel");
      expect(stopChildren).toHaveBeenCalledTimes(stopsChildren ? 1 : 0);
      await active;
    } finally {
      for (const input of [firstQueued, secondQueued]) {
        if (!input.abortSignal.aborted) {
          retireSessionControllerInput(input);
        }
      }
      await active.catch(() => undefined);
    }
  },
);

it("cancels queued inputs independently of abort-if-abortable active policy", async () => {
  const target = targetFixture("preempt-queued", "preempt-queued-session");
  const input = reserveSource(target);
  const applied = createDeferred();
  const run = vi.fn(async () => {});
  const mutation = runSessionMutation({
    target,
    kind: "compaction",
    policy: "preempt",
    preempt: {
      activeRun: "abort-if-abortable",
      waitingInputs: "cancel",
      stopChildren: async (applyParentStop) => {
        await applyParentStop();
        applied.resolve();
        return { stopped: 0, failed: 0 };
      },
    },
    run,
  });
  try {
    await applied.promise;
    expect(input.abortSignal.aborted).toBe(true);
    await mutation;
    expect(run).toHaveBeenCalledOnce();
  } finally {
    retireSessionControllerInput(input);
    await Promise.allSettled([input.settlement.promise, mutation]);
  }
});

it("does not run a preemptive mutation after its caller aborts during source cleanup", async () => {
  const target = targetFixture("mutation-cleanup-cancellation");
  const cleanup = pause();
  const input = reserveSource(target, {
    adapter: { onSettled: cleanup.run },
  });
  const caller = new AbortController();
  const reason = new Error("mutation caller cancelled during cleanup");
  const run = vi.fn(async () => {});
  const mutation = runSessionMutation({
    target,
    kind: "reset",
    ...abortAndCancel,
    signal: caller.signal,
    run,
  });
  const rejected = expect(mutation).rejects.toBe(reason);
  try {
    await cleanup.started;
    expect(run).not.toHaveBeenCalled();
    caller.abort(reason);
    cleanup.finish();
    await rejected;
    await input.settlement.promise;
    expect(run).not.toHaveBeenCalled();
  } finally {
    cleanup.finish();
    retireSessionControllerInput(input);
    await Promise.allSettled([input.settlement.promise, mutation]);
  }
});

it.each(["caller", "authority"] as const)(
  "rechecks %s cancellation after preparation before interrupting effects",
  async (invalidation) => {
    const target = targetFixture(`mutation-${invalidation}-authority`);
    const onInterrupt = vi.fn();
    const effect = await beginSessionEffect({ target, onInterrupt });
    const preparation = pause();
    const caller = new AbortController();
    const reason = new Error("mutation authority revoked during preparation");
    let current = true;
    const run = vi.fn(async () => {});
    const mutation = runSessionMutation({
      target,
      kind: "reset",
      ...abortAndCancel,
      signal: caller.signal,
      assertCurrent: () => {
        if (!current) {
          throw reason;
        }
      },
      prepare: preparation.run,
      run,
    });
    const rejected = expect(mutation).rejects.toBe(reason);
    try {
      await preparation.started;
      if (invalidation === "caller") {
        caller.abort(reason);
      } else {
        current = false;
      }
      preparation.finish();
      await rejected;
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(effect.isActive()).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally {
      preparation.finish();
      effect.release();
      await Promise.allSettled([mutation]);
    }
  },
);

it("bounds preempt settlement with a typed mutation timeout", async () => {
  vi.useFakeTimers();
  const target = targetFixture("preempt-timeout", "preempt-timeout-session");
  const effect = await beginSessionEffect({ target });
  const run = vi.fn(async () => {});
  const mutation = runSessionMutation({
    target,
    kind: "delete",
    policy: "preempt",
    preempt: { activeRun: "abort", waitingInputs: "cancel", settleTimeoutMs: 1_000 },
    run,
  });
  const observedMutation = mutation.catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    const timeoutError = await observedMutation;
    expect(timeoutError).toBeInstanceOf(SessionMutationPreemptTimeoutError);
    expect(timeoutError).toMatchObject({
      name: "SessionMutationPreemptTimeoutError",
      sessionKey: target.sessionKey,
      mutationKind: "delete",
    });
    expect(run).not.toHaveBeenCalled();
  } finally {
    effect.release();
    await observedMutation;
    vi.useRealTimers();
  }
});

it("reset preserves its effect source and cancels waiting input", async ({ signal }) => {
  const target = targetFixture("effect-source-reset", "effect-source-session");
  const input = reserveSource(target);
  const sibling = reserveSource(target);
  const effect = await beginSessionEffect({ target, sourceInput: input });
  const reason = new Error("reset waiting inputs");
  const run = vi.fn(async () => {});
  try {
    await effect.run(async () =>
      runSessionMutation({
        target,
        kind: "reset",
        policy: "preempt",
        preempt: { activeRun: "abort", waitingInputs: "cancel", reason },
        signal,
        run,
      }),
    );
    expect(run).toHaveBeenCalledOnce();
    expect(effect.isActive()).toBe(true);
    expect(input.claim).toBeUndefined();
    expect(input.abortSignal.aborted).toBe(false);
    expect(input.retirementRequested).not.toBe(true);
    expect(sibling.abortSignal).toMatchObject({ aborted: true });
    expect(sibling.abortSignal.reason).toBe(reason);
    await sibling.settlement.promise;
  } finally {
    effect.release();
    retireSessionControllerInput(input);
    retireSessionControllerInput(sibling);
    await Promise.all([effect.released, input.settlement.promise, sibling.settlement.promise]);
  }
});

for (const policy of ["wait", "preempt"] as const) {
  it(`keeps a queued-source effect through ${policy} until its turn`, async ({ signal }) => {
    const target = targetFixture("queued-source-effect-compaction", "queued-source-session");
    const input = reserveSource(target);
    const interrupted = vi.fn();
    const effect = await beginSessionEffect({
      target,
      sourceInput: input,
      onInterrupt: interrupted,
    });
    const effectReleased = vi.fn();
    const sourceSettled = vi.fn();
    void effect.released.then(effectReleased);
    void input.settlement.promise.then(sourceSettled);
    const order: string[] = [];
    try {
      await runSessionMutation({
        target,
        ...(policy === "wait" ? { kind: "compaction" as const, policy } : compact),
        signal,
        run: async () => {
          order.push("compaction");
        },
      });
      expect(interrupted).not.toHaveBeenCalled();
      expect(effect.isActive()).toBe(true);
      expect(effectReleased).not.toHaveBeenCalled();
      expect(input.abortSignal.aborted).toBe(false);
      expect(input.claim).toBeUndefined();
      expect(sourceSettled).not.toHaveBeenCalled();
      await withSessionTurn(
        {
          ...turnOptions(target),
          controllerInput: input,
          abortSignal: signal,
        },
        async () =>
          await effect.run(async () => {
            order.push("source");
          }),
      );
      expect(order).toEqual(["compaction", "source"]);
    } finally {
      effect.release();
      retireSessionControllerInput(input);
      await Promise.all([effect.released, input.settlement.promise]);
    }
  });
}

it("keeps a queued turn behind compaction until the mutation finishes", async () => {
  const target = targetFixture("queued-behind-compaction", "queued-behind-session");
  const { active } = await abortableTurn(target);
  const runQueued = vi.fn(async () => {});
  const queued = withSessionTurn(turnOptions(target), runQueued);
  const work = pause();
  const mutation = runSessionMutation({ target, ...compact, run: work.run });
  try {
    await work.started;
    await active;
    expect(runQueued).not.toHaveBeenCalled();
    work.finish();
    await mutation;
    await queued;
    expect(runQueued).toHaveBeenCalledOnce();
  } finally {
    work.finish();
    await Promise.allSettled([active, mutation, queued]);
  }
});

it.each(["maintenance", "autonomous", "rpc"] as const)(
  "publishes settlement only for autonomous backend turns (%s)",
  async (source) => {
    const target = targetFixture(`settlement-${source}`, `settlement-${source}-id`);
    const input =
      source === "rpc" ? reserveSource(target, { protocolRunId: "rpc-run" }) : undefined;
    if (input) {
      registerRpcSource("rpc-run", { input, adapter: { kind: "chat-send" } });
    }
    const events: SessionLifecycleEvent[] = [];
    const unsubscribe = onSessionLifecycleEvent((event) => events.push(event));
    try {
      await withSessionTurn(
        { ...turnOptions(target), controllerInput: input },
        async (operation) => {
          if (source !== "maintenance") {
            expectDefined(operation, "admitted operation").attachBackend({
              kind: "embedded",
              runId: "backend-run",
              cancel: () => {},
              isStreaming: () => false,
            });
          }
        },
      );
      expect(events).toEqual(
        source === "autonomous"
          ? [
              {
                sessionKey: target.sessionKey,
                agentId: "main",
                reason: "agent.input.settled",
                scope: "runtime",
              },
            ]
          : [],
      );
    } finally {
      unsubscribe();
      if (input) {
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
    }
  },
);
