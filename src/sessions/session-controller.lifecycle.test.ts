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

it.each([
  ["wait", "operation"],
  ["preempt", "operation"],
  ["wait", "claim"],
  ["preempt", "claim"],
] as const)("%s mutation does not capture another incarnation's %s", async (policy, kind) => {
  vi.useFakeTimers();
  const target = captureSessionTarget({
    storeScope: "/synthetic/mutation-incarnation/sessions.json",
    sessionKey: `agent:main:mutation-${policy}-${kind}`,
    incarnation: "new",
  });
  const old = captureSessionTarget({
    storeScope: target.storeScope,
    sessionKey: target.sessionKey,
    incarnation: "old",
  });
  const operation =
    kind === "operation"
      ? createReplyOperation({
          sessionKey: target.sessionKey,
          sessionId: "new",
          target,
          resetTriggered: false,
        })
      : undefined;
  const input =
    kind === "claim"
      ? reserveSessionControllerSource(target.sessionKey, { target, policy: { mode: "followup" } })
      : undefined;
  const claim = input ? await claimSessionControllerTask(input, () => {}) : undefined;
  let ran = false;
  const mutation = runSessionMutation({
    target: old,
    requiredSessionId: "old",
    ...(policy === "preempt"
      ? {
          kind: "reset" as const,
          policy,
          preempt: { activeRun: "abort" as const, waitingInputs: "cancel" as const },
        }
      : { policy }),
    run: async () => {
      ran = true;
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(operation?.abortSignal.aborted ?? claim?.abortController.signal.aborted).toBe(false);
    expect(ran).toBe(true);
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
  const target = captureSessionTarget({
    storeScope: "gateway-claim.sqlite",
    sessionKey: "agent:main:gateway-claim",
    incarnation: "gateway-claim-id",
  });
  const gatewayA = () => {
    throw new Error("capture must not resolve a Gateway context");
  };
  const gatewayB = () => {
    throw new Error("capture must not resolve a Gateway context");
  };
  const firstStarted = createDeferred();
  const firstFinish = createDeferred();
  const secondStarted = createDeferred();
  const secondFinish = createDeferred();
  const cleanupStarted = createDeferred();
  const cleanupFinish = createDeferred();
  const first = withPluginRuntimeGatewayContextResolver(gatewayA, () =>
    withSessionTurn({ sessionKey: target.sessionKey, target }, async () => {
      firstStarted.resolve();
      await firstFinish.promise;
    }),
  );
  await firstStarted.promise;
  const input = withPluginRuntimeGatewayContextResolver(gatewayB, () =>
    reserveSessionControllerSource(target.sessionKey, {
      target,
      policy: { mode: "followup" },
      adapter: {
        onSettled: async () => {
          cleanupStarted.resolve();
          await cleanupFinish.promise;
        },
      },
    }),
  );
  // Gateway A's completion wakes B's selected source before any operation exists.
  const second = withSessionTurn(
    { sessionKey: target.sessionKey, target, controllerInput: input },
    async (operation) => {
      expect(operation).toBeUndefined();
      secondStarted.resolve();
      await secondFinish.promise;
    },
  );
  const query = {
    scope: target.storeScope,
    sessionKey: target.sessionKey,
    sessionId: "gateway-claim-id",
  };
  try {
    firstFinish.resolve();
    await first;
    await secondStarted.promise;
    const claim = input.claim;
    if (!claim) {
      throw new Error("selected source has no claim");
    }
    const captured = captureGatewaySessionControllerWork(gatewayB);
    expect(captured.targets.get(target.storeScope)).toContain(target.sessionKey);
    expect(captured.isActive(query)).toBe(true);
    expect(captureGatewaySessionControllerWork(gatewayA).isActive(query)).toBe(false);
    secondFinish.resolve();
    await second;
    await cleanupStarted.promise;
    expect(captured.isActive(query)).toBe(true);
    cleanupFinish.resolve();
    await claim.settlement.promise;
    expect(captured.isActive(query)).toBe(false);
    await withPluginRuntimeGatewayContextResolver(gatewayB, () =>
      withSessionTurn({ sessionKey: target.sessionKey, target }, async () => {
        expect(captured.isActive(query)).toBe(false);
        expect(captureGatewaySessionControllerWork(gatewayB).isActive(query)).toBe(true);
      }),
    );
  } finally {
    firstFinish.resolve();
    secondFinish.resolve();
    cleanupFinish.resolve();
    await Promise.all([first, second, input.settlement.promise]);
  }
});

it("retains a frozen controller owner through refused preemption until its actual settlement", async () => {
  const target = captureSessionTarget({
    storeScope: "frozen-owner.sqlite",
    sessionKey: "agent:main:frozen-owner",
    incarnation: "frozen-id",
  });
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: "frozen-id",
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  operation.freezeAbort();
  const prepared = createDeferred();
  let mutated = false;
  const mutation = runSessionMutation({
    target,
    kind: "reset",
    policy: "preempt",
    preempt: { activeRun: "abort", waitingInputs: "cancel" },
    prepare: async () => {
      prepared.resolve();
    },
    run: async () => {
      mutated = true;
    },
  });
  await prepared.promise;
  expect(operation.abortByUser()).toBe(false);
  expect(mutated).toBe(false);
  expect(isSessionMutationActive(target.storeScope, target.aliases)).toBe(true);
  let admitted = false;
  const effect = beginSessionEffect({
    target,
    assertAllowed: () => {
      admitted = true;
    },
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  operation.complete();
  await mutation;
  (await effect).release();
  expect(mutated).toBe(true);
  expect(admitted).toBe(true);
});

it("borrows the exact in-band owner without interrupting or awaiting its own stack", async () => {
  const target = captureSessionTarget({
    storeScope: "own-stack.sqlite",
    sessionKey: "agent:main:own-stack",
    incarnation: "own-id",
  });
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: "own-id",
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  try {
    await withSessionControllerOwner(operation, () =>
      runSessionMutation({
        target,
        kind: "reset",
        policy: "preempt",
        preempt: { activeRun: "abort", waitingInputs: "cancel" },
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
  const target = captureSessionTarget({
    storeScope: "live-sharing.sqlite",
    sessionKey: "agent:main:live-sharing",
    incarnation: "sharing-id",
  });
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: "sharing-id",
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  const effect = await beginSessionEffect({ target, operation, assertAllowed: () => {} });
  let revoked = false;
  try {
    await runSessionMutation({
      target,
      policy: "allow-live",
      run: async () => {
        revoked = true;
      },
    });
    expect(revoked).toBe(true);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(effect.isActive()).toBe(true);
  } finally {
    effect.release();
    operation.complete();
  }
});

it("release cannot manufacture completion while captured writer cleanup is still running", async () => {
  const target = captureSessionTarget({
    storeScope: "retained-effect.sqlite",
    sessionKey: "agent:main:retained-effect",
  });
  const effect = await beginSessionEffect({ target, assertAllowed: () => {} });
  const entered = createDeferred();
  const finish = createDeferred();
  const running = effect.run(async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  const interruption = startSessionControllerInterruption({ target });
  let settled = false;
  void interruption.released.then(() => {
    settled = true;
  });
  effect.release();
  await Promise.resolve();
  expect(effect.isActive()).toBe(false);
  expect(settled).toBe(false);
  finish.resolve();
  await running;
  await interruption.released;
  expect(settled).toBe(true);
});

it("hands off only the captured raw source and joins other interrupted cleanup", async ({
  signal,
}) => {
  const target = captureSessionTarget({
    storeScope: "handoff-source.sqlite",
    sessionKey: "agent:main:handoff-source",
  });
  const deferredCleanup = createDeferred();
  const otherCleanup = createDeferred();
  const deferredInput = reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
  });
  const otherInput = reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
  });
  trackSessionControllerSourceWork(deferredInput, deferredCleanup.promise);
  trackSessionControllerSourceWork(otherInput, otherCleanup.promise);
  let deferredSettled = false;
  void deferredInput.settlement.promise.then(() => {
    deferredSettled = true;
  });
  const interruption = startSessionControllerInterruption({
    target,
    admissionsOnly: true,
    deferSourceSettlement: deferredInput,
  });
  let interruptedSettled = false;
  void interruption.released.then(() => {
    interruptedSettled = true;
  });
  try {
    expect(deferredInput.abortSignal.aborted).toBe(true);
    expect(otherInput.abortSignal.aborted).toBe(true);
    await runSessionMutation({
      target: captureSessionTarget({ ...target, storeScope: "foreign-handoff-source.sqlite" }),
      run: async () => {},
    });
    expect(interruptedSettled).toBe(false);
    otherCleanup.resolve();
    await withinTest(interruption.released, signal);
    expect(deferredSettled).toBe(false);
    expect(interruptedSettled).toBe(true);
  } finally {
    deferredCleanup.resolve();
    otherCleanup.resolve();
    await Promise.all([
      deferredInput.settlement.promise,
      otherInput.settlement.promise,
      interruption.released,
    ]);
  }
  expect(deferredSettled).toBe(true);
});

it("preempt interrupts a captured subordinate effect before running the mutation", async () => {
  const target = captureSessionTarget({
    storeScope: "preempt-effect.sqlite",
    sessionKey: "agent:main:preempt-effect",
    incarnation: "preempt-effect-session",
  });
  let releaseEffect = () => {};
  const interrupted = vi.fn(() => releaseEffect());
  const effect = await beginSessionEffect({
    target,
    assertAllowed: () => {},
    onInterrupt: interrupted,
  });
  releaseEffect = effect.release;
  let mutated = false;

  await runSessionMutation({
    target,
    kind: "reset",
    policy: "preempt",
    preempt: { activeRun: "abort", waitingInputs: "cancel" },
    run: async () => {
      mutated = true;
    },
  });

  expect(interrupted).toHaveBeenCalledOnce();
  expect(effect.isActive()).toBe(false);
  expect(mutated).toBe(true);
});

it.each(["wait", "preempt"] as const)(
  "%s mutation joins unclaimed source cleanup without blocking a foreign store",
  async (policy) => {
    const target = captureSessionTarget({
      storeScope: "retiring-source.sqlite",
      sessionKey: "agent:main:retiring-source",
      incarnation: "retiring-source-id",
    });
    const cleanup = createDeferred();
    const input = reserveSessionControllerSource(target.sessionKey, {
      target,
      policy: { mode: "followup" },
      adapter: { onSettled: () => cleanup.promise },
    });
    retireSessionControllerInput(input);
    let ran = false;
    const mutation = runSessionMutation({
      target,
      ...(policy === "preempt"
        ? {
            kind: "reset" as const,
            policy,
            preempt: { activeRun: "abort" as const, waitingInputs: "cancel" as const },
          }
        : { policy }),
      run: async () => {
        ran = true;
      },
    });
    try {
      // The same mutation path in another physical store proves the scheduler progressed.
      await runSessionMutation({
        target: captureSessionTarget({ ...target, storeScope: "foreign-source.sqlite" }),
        ...(policy === "preempt"
          ? {
              kind: "reset" as const,
              policy,
              preempt: { activeRun: "abort" as const, waitingInputs: "cancel" as const },
            }
          : { policy }),
        run: async () => {},
      });
      expect(ran).toBe(false);
    } finally {
      cleanup.resolve();
      await input.settlement.promise;
      await mutation;
    }
    expect(ran).toBe(true);
  },
);

it.each([
  ["reset", "cancel", true],
  ["delete", "cancel", false],
  ["compaction", "keep", false],
] as const)(
  "%s preemption applies its queued-input and child policy through Stop",
  async (kind, waitingInputs, stopsChildren) => {
    const target = captureSessionTarget({
      storeScope: `${kind}-preempt.sqlite`,
      sessionKey: `agent:main:${kind}-preempt`,
      incarnation: `${kind}-session`,
    });
    const running = createDeferred();
    const active = withSessionTurn(
      {
        sessionKey: target.sessionKey,
        sessionId: target.incarnation,
        target,
      },
      async (_operation, signal) => {
        running.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
      },
    );
    await running.promise;
    const firstQueued = reserveSessionControllerSource(target.sessionKey, {
      target,
      policy: { mode: "followup" },
    });
    const secondQueued = reserveSessionControllerSource(target.sessionKey, {
      target,
      policy: { mode: "followup" },
    });
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
      if (!firstQueued.abortSignal.aborted) {
        retireSessionControllerInput(firstQueued);
      }
      if (!secondQueued.abortSignal.aborted) {
        retireSessionControllerInput(secondQueued);
      }
      await active.catch(() => undefined);
    }
  },
);

it("cancels queued inputs independently of abort-if-abortable active policy", async () => {
  const target = captureSessionTarget({
    storeScope: "/synthetic/preempt-queued/sessions.sqlite",
    sessionKey: "agent:main:preempt-queued",
    incarnation: "preempt-queued-session",
  });
  const input = reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
  });
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
  const target = captureSessionTarget({
    storeScope: "/synthetic/mutation-cleanup-cancellation/sessions.sqlite",
    sessionKey: "agent:main:mutation-cleanup-cancellation",
  });
  const cleanupStarted = createDeferred();
  const finishCleanup = createDeferred();
  const input = reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
    adapter: {
      onSettled: async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
      },
    },
  });
  const caller = new AbortController();
  const reason = new Error("mutation caller cancelled during cleanup");
  const run = vi.fn(async () => {});
  const mutation = runSessionMutation({
    target,
    kind: "reset",
    policy: "preempt",
    preempt: { activeRun: "abort", waitingInputs: "cancel" },
    signal: caller.signal,
    run,
  });
  const rejected = expect(mutation).rejects.toBe(reason);
  try {
    await cleanupStarted.promise;
    expect(run).not.toHaveBeenCalled();
    caller.abort(reason);
    finishCleanup.resolve();
    await rejected;
    await input.settlement.promise;
    expect(run).not.toHaveBeenCalled();
  } finally {
    finishCleanup.resolve();
    retireSessionControllerInput(input);
    await Promise.allSettled([input.settlement.promise, mutation]);
  }
});

it.each(["caller", "authority"] as const)(
  "rechecks %s cancellation after preparation before interrupting effects",
  async (invalidation) => {
    const target = captureSessionTarget({
      storeScope: `/synthetic/mutation-${invalidation}-authority/sessions.sqlite`,
      sessionKey: `agent:main:mutation-${invalidation}-authority`,
    });
    const onInterrupt = vi.fn();
    const effect = await beginSessionEffect({ target, onInterrupt });
    const prepared = createDeferred();
    const finishPreparation = createDeferred();
    const caller = new AbortController();
    const reason = new Error("mutation authority revoked during preparation");
    let current = true;
    const run = vi.fn(async () => {});
    const mutation = runSessionMutation({
      target,
      kind: "reset",
      policy: "preempt",
      preempt: { activeRun: "abort", waitingInputs: "cancel" },
      signal: caller.signal,
      assertCurrent: () => {
        if (!current) {
          throw reason;
        }
      },
      prepare: async () => {
        prepared.resolve();
        await finishPreparation.promise;
      },
      run,
    });
    const rejected = expect(mutation).rejects.toBe(reason);
    try {
      await prepared.promise;
      if (invalidation === "caller") {
        caller.abort(reason);
      } else {
        current = false;
      }
      finishPreparation.resolve();
      await rejected;
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(effect.isActive()).toBe(true);
      expect(run).not.toHaveBeenCalled();
    } finally {
      finishPreparation.resolve();
      effect.release();
      await Promise.allSettled([mutation]);
    }
  },
);

it("compaction preserves a non-abortable run until its real settlement", async () => {
  const target = captureSessionTarget({
    storeScope: "non-abortable-compaction.sqlite",
    sessionKey: "agent:main:non-abortable-compaction",
    incarnation: "non-abortable-session",
  });
  const operation = createReplyOperation({
    sessionKey: target.sessionKey,
    sessionId: target.incarnation!,
    target,
    resetTriggered: false,
  });
  bindSessionControllerTarget(operation, target);
  operation.freezeAbort();
  let mutated = false;
  const mutation = runSessionMutation({
    target,
    kind: "compaction",
    policy: "preempt",
    preempt: { activeRun: "abort-if-abortable", waitingInputs: "keep" },
    run: async () => {
      mutated = true;
    },
  });
  try {
    await Promise.resolve();
    expect(operation.abortSignal.aborted).toBe(false);
    expect(mutated).toBe(false);
    operation.complete();
    await mutation;
    expect(mutated).toBe(true);
  } finally {
    operation.complete();
    await mutation;
  }
});

it("bounds preempt settlement with a typed mutation timeout", async () => {
  vi.useFakeTimers();
  const target = captureSessionTarget({
    storeScope: "preempt-timeout.sqlite",
    sessionKey: "agent:main:preempt-timeout",
    incarnation: "preempt-timeout-session",
  });
  const effect = await beginSessionEffect({ target, assertAllowed: () => {} });
  let mutated = false;
  const mutation = runSessionMutation({
    target,
    kind: "delete",
    policy: "preempt",
    preempt: { activeRun: "abort", waitingInputs: "cancel", settleTimeoutMs: 1_000 },
    run: async () => {
      mutated = true;
    },
  });
  let timeoutError: unknown;
  const observedMutation = mutation.catch((error: unknown) => {
    timeoutError = error;
  });
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    await observedMutation;
    expect(timeoutError).toBeInstanceOf(SessionMutationPreemptTimeoutError);
    expect(timeoutError).toMatchObject({
      name: "SessionMutationPreemptTimeoutError",
      sessionKey: target.sessionKey,
      mutationKind: "delete",
    });
    expect(mutated).toBe(false);
  } finally {
    effect.release();
    await observedMutation;
    vi.useRealTimers();
  }
});

it("keeps an admitted effect's own source through reset while cancelling a waiting sibling", async ({
  signal,
}) => {
  const target = captureSessionTarget({
    storeScope: "effect-source-reset.sqlite",
    sessionKey: "agent:main:effect-source-reset",
    incarnation: "effect-source-session",
  });
  const input = reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
  });
  const sibling = reserveSessionControllerSource(target.sessionKey, {
    target,
    policy: { mode: "followup" },
  });
  const effect = await beginSessionEffect({ target, sourceInput: input });
  const reason = new Error("reset waiting inputs");
  let resetCompleted = false;
  try {
    await effect.run(async () =>
      runSessionMutation({
        target,
        kind: "reset",
        policy: "preempt",
        preempt: { activeRun: "abort", waitingInputs: "cancel", reason },
        signal,
        run: async () => {
          resetCompleted = true;
        },
      }),
    );
    expect(resetCompleted).toBe(true);
    expect(effect.isActive()).toBe(true);
    expect(input.claim).toBeUndefined();
    expect(input.abortSignal.aborted).toBe(false);
    expect(input.retirementRequested).not.toBe(true);
    expect(sibling.abortSignal.aborted).toBe(true);
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
  it(`preserves an acquired queued-source effect through a ${policy} mutation until its turn runs`, async ({
    signal,
  }) => {
    const target = captureSessionTarget({
      storeScope: "queued-source-effect-compaction.sqlite",
      sessionKey: "agent:main:queued-source-effect-compaction",
      incarnation: "queued-source-session",
    });
    const input = reserveSessionControllerSource(target.sessionKey, {
      target,
      policy: { mode: "followup" },
    });
    const interrupted = vi.fn();
    const effect = await beginSessionEffect({
      target,
      sourceInput: input,
      onInterrupt: interrupted,
    });
    let effectReleased = false;
    let sourceSettled = false;
    void effect.released.then(() => {
      effectReleased = true;
    });
    void input.settlement.promise.then(() => {
      sourceSettled = true;
    });
    const order: string[] = [];
    try {
      await runSessionMutation({
        target,
        kind: "compaction",
        ...(policy === "wait"
          ? { policy }
          : { policy, preempt: { activeRun: "abort-if-abortable", waitingInputs: "keep" } }),
        signal,
        run: async () => {
          order.push("compaction");
        },
      });
      expect(interrupted).not.toHaveBeenCalled();
      expect(effect.isActive()).toBe(true);
      expect(effectReleased).toBe(false);
      expect(input.abortSignal.aborted).toBe(false);
      expect(input.claim).toBeUndefined();
      expect(sourceSettled).toBe(false);
      await withSessionTurn(
        {
          target,
          sessionKey: target.sessionKey,
          sessionId: target.incarnation,
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
  const target = captureSessionTarget({
    storeScope: "queued-behind-compaction.sqlite",
    sessionKey: "agent:main:queued-behind-compaction",
    incarnation: "queued-behind-session",
  });
  const running = createDeferred();
  const active = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId: target.incarnation, target },
    async (_operation, signal) => {
      running.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
    },
  );
  await running.promise;
  let queuedStarted = false;
  const queued = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId: target.incarnation, target },
    async () => {
      queuedStarted = true;
    },
  );
  const mutationStarted = createDeferred();
  const finishMutation = createDeferred();
  const mutation = runSessionMutation({
    target,
    kind: "compaction",
    policy: "preempt",
    preempt: { activeRun: "abort-if-abortable", waitingInputs: "keep" },
    run: async () => {
      mutationStarted.resolve();
      await finishMutation.promise;
    },
  });
  try {
    await mutationStarted.promise;
    await active;
    expect(queuedStarted).toBe(false);
    finishMutation.resolve();
    await mutation;
    await queued;
    expect(queuedStarted).toBe(true);
  } finally {
    finishMutation.resolve();
    await Promise.allSettled([active, mutation, queued]);
  }
});
