import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentRunDirectAbortError,
  isAgentRunDirectAbortReason,
} from "../agents/run-termination.js";
import {
  registerInternalHook,
  unregisterInternalHook,
  type InternalHookEvent,
} from "../hooks/internal-hooks.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureSessionControllerEffects } from "./session-controller.lifecycle-work.js";
import { beginSessionEffect, captureSessionTarget } from "./session-controller.lifecycle.js";
import {
  beginSessionControllerSourceInjection,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  retireSessionControllerSourceCancellation,
  trackSessionControllerSourceWork,
} from "./session-controller.mailbox.js";
import { createReplyOperation } from "./session-controller.operation.js";
import {
  captureSessionControllerStop,
  captureSessionControllerStopCandidates,
  stopSession,
  type SessionStopSource,
} from "./session-controller.stop.js";

function fixture() {
  const sessionKey = "agent:main:stop-boundary";
  const sessionId = randomUUID();
  const target = captureSessionTarget({
    storeScope: "/synthetic/stop/" + sessionId,
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const reserve = (protocolRunId: string) =>
    reserveSessionControllerSource(sessionKey, {
      target,
      protocolRunId,
      policy: { mode: "followup" },
    });
  return { sessionKey, sessionId, target, reserve };
}

const policyCases = [
  ["channel-user", true, true, true, true],
  ["client-session", true, true, false, true],
  ["client-run", true, true, false, true],
  ["interrupt", true, false, false, false],
  ["restart", true, false, false, false],
  ["watchdog", false, false, false, false],
  ["operator-revocation", true, false, false, false],
  ["supersede", false, false, false, false],
] as const satisfies ReadonlyArray<
  readonly [SessionStopSource, boolean, boolean, boolean, boolean]
>;

describe("captured session Stop", () => {
  it.each(["cancelled", "producer failure", "cleanup failure", "writer failure"] as const)(
    "separates the run outcome from retained Stop settlement: %s",
    async (scenario) => {
      const f = fixture();
      const retained = createDeferredCore();
      const input = reserveSessionControllerSource(f.sessionKey, {
        target: f.target,
        policy: { mode: "followup" },
        adapter: {
          onSettled: () => (scenario === "writer failure" ? undefined : retained.promise),
        },
      });
      if (scenario === "writer failure") {
        trackSessionControllerSourceWork(input, retained.promise);
      }
      const started = createDeferredCore();
      const finish = createDeferredCore();
      const reason = createAgentRunDirectAbortError();
      const producerError = new Error("synthetic provider failure");
      const cleanupError = new Error("synthetic retained work failure");
      const execution = withSessionTurn(
        {
          sessionKey: f.sessionKey,
          sessionId: f.sessionId,
          target: f.target,
          controllerInput: input,
        },
        async (_operation, signal) => {
          started.resolve();
          await finish.promise;
          if (scenario === "producer failure") {
            throw producerError;
          }
          signal.throwIfAborted();
        },
      );
      void execution.catch(() => {});
      await started.promise;
      const stop = stopSession({
        source: "client-run",
        capture: captureSessionControllerStop({ inputs: [input] }),
        reason,
        hookContext: { sessionKey: f.sessionKey },
      });
      let settled = false;
      void stop.settled.then(
        () => (settled = true),
        () => (settled = true),
      );
      try {
        expect(await stop.completed).toMatchObject({ aborted: true, activeCancelled: 1 });
        finish.resolve();
        await expect(execution).rejects.toBe(
          scenario === "producer failure" ? producerError : reason,
        );
        expect(settled).toBe(false);
        if (scenario === "cleanup failure" || scenario === "writer failure") {
          retained.reject(cleanupError);
          await expect(stop.settled).rejects.toMatchObject({ errors: [cleanupError] });
        } else {
          retained.resolve();
          await expect(stop.settled).resolves.toBeUndefined();
        }
      } finally {
        finish.resolve();
        retained.resolve();
        await Promise.allSettled([execution, stop.completed, stop.settled]);
      }
    },
  );

  it("keeps a newer runless callback effect until Stop names its incarnation", async () => {
    const f = fixture();
    const replacementTarget = captureSessionTarget({ ...f.target, incarnation: randomUUID() });
    const onInterrupt = vi.fn();
    const effect = await beginSessionEffect({ target: replacementTarget, onInterrupt });
    try {
      const staleOutcome = await stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ targets: [f.target] }),
      }).completed;
      expect(staleOutcome).toMatchObject({ aborted: false, activeCancelled: 0 });
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(effect.isActive()).toBe(true);

      const matchingOutcome = await stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ targets: [replacementTarget] }),
      }).completed;
      expect(matchingOutcome).toMatchObject({ aborted: true, activeCancelled: 1 });
      expect(onInterrupt).toHaveBeenCalledOnce();
      expect(effect.isActive()).toBe(false);
    } finally {
      effect.release();
      await effect.released;
    }
  });

  it("leaves a replacement operation running when Stop names an older incarnation", async () => {
    const f = fixture();
    const replacementId = randomUUID();
    const operation = createReplyOperation({
      sessionKey: f.sessionKey,
      sessionId: replacementId,
      resetTriggered: false,
      target: captureSessionTarget({ ...f.target, incarnation: replacementId }),
    });
    try {
      const outcome = await stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ targets: [f.target] }),
      }).completed;
      expect(outcome).toMatchObject({ aborted: false, activeCancelled: 0 });
      expect(operation.abortSignal.aborted).toBe(false);
    } finally {
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it("leaves a replacement native input running when Stop names an older incarnation", async () => {
    const f = fixture();
    const input = reserveSessionControllerSource(f.sessionKey, {
      target: captureSessionTarget({ ...f.target, incarnation: randomUUID() }),
      policy: { mode: "followup" },
    });
    const injection = beginSessionControllerSourceInjection(input);
    expect(await injection.admit()).toBe(true);
    try {
      const outcome = await stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ targets: [f.target] }),
      }).completed;
      expect(outcome).toMatchObject({ aborted: false, activeCancelled: 0 });
      expect(input.abortSignal.aborted).toBe(false);
    } finally {
      injection.finish(false);
      retireSessionControllerInput(input);
      await input.settlement.promise;
    }
  });

  it("still stops an operation through an incarnation it owns after rollover", async () => {
    const f = fixture();
    const operation = createReplyOperation({
      sessionKey: f.sessionKey,
      sessionId: f.sessionId,
      resetTriggered: false,
      target: f.target,
    });
    operation.updateSessionId(randomUUID());
    try {
      const outcome = await stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ targets: [f.target] }),
      }).completed;
      expect(outcome).toMatchObject({ aborted: true, activeCancelled: 1 });
      expect(operation.abortSignal.aborted).toBe(true);
    } finally {
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it("cancels scoped runless effects without waiting for their producer release", async () => {
    const f = fixture();
    const gateway = () => undefined;
    const siblingGateway = () => undefined;
    const ownInterrupt = vi.fn();
    const siblingInterrupt = vi.fn();
    const own = await beginSessionEffect({
      target: f.target,
      resolveGatewayContext: gateway,
      onInterrupt: ownInterrupt,
    });
    const sibling = await beginSessionEffect({
      target: f.target,
      resolveGatewayContext: siblingGateway,
      onInterrupt: siblingInterrupt,
    });
    try {
      const capture = captureSessionControllerStop({
        effects: captureSessionControllerEffects({ target: f.target }),
        resolveGatewayContext: gateway,
      });
      expect(capture.effects).toHaveLength(1);
      const publishRun = vi.fn();
      const execution = stopSession({
        source: "restart",
        capture,
        onEffectCancelled: publishRun,
      });
      const outcome = await execution.completed;
      expect(outcome).toMatchObject({ aborted: true, activeCancelled: 1 });
      expect(ownInterrupt).toHaveBeenCalledOnce();
      expect(siblingInterrupt).not.toHaveBeenCalled();
      expect(publishRun).not.toHaveBeenCalled();
      let settled = false;
      void outcome.settled.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      own.release();
      await outcome.settled;
      expect(settled).toBe(true);
    } finally {
      own.release();
      sibling.release();
    }
  });

  it("retains committed effect cancellation when its observer throws", async () => {
    const f = fixture();
    const failure = new Error("producer interruption observer failed");
    const admission = await beginSessionEffect({
      target: f.target,
      onInterrupt: () => {
        throw failure;
      },
    });
    try {
      const capture = captureSessionControllerStop({ targets: [f.target] });
      const execution = stopSession({ source: "restart", capture });
      expect(execution).toMatchObject({ aborted: true, activeCancelled: 1 });
      await expect(execution.completed).rejects.toThrow(failure);
      expect(execution.failures).toEqual([{ target: capture.effects[0], error: failure }]);
      expect(admission.isActive()).toBe(false);
    } finally {
      admission.release();
    }
  });

  it("selects only the captured Gateway and physical store, excluding unbound sources", async () => {
    const f = fixture();
    const gateway = () => undefined;
    const siblingGateway = () => undefined;
    const own = withPluginRuntimeGatewayContextResolver(gateway, () => f.reserve("own"));
    const sibling = withPluginRuntimeGatewayContextResolver(siblingGateway, () =>
      f.reserve("sibling"),
    );
    const unbound = f.reserve("unbound");
    const otherStore = withPluginRuntimeGatewayContextResolver(gateway, () =>
      reserveSessionControllerSource(f.sessionKey, {
        target: captureSessionTarget({ ...f.target, storeScope: f.target.storeScope + "/other" }),
        protocolRunId: "other-store",
        policy: { mode: "followup" },
      }),
    );
    const capture = captureSessionControllerStop({
      targets: [f.target],
      resolveGatewayContext: gateway,
    });
    expect(capture.inputs).toEqual([own]);
    expect(
      captureSessionControllerStop({
        targets: [f.target],
        resolveGatewayContext: undefined,
      }).inputs,
    ).toEqual([unbound]);
    const candidates = captureSessionControllerStopCandidates({ resolveGatewayContext: gateway });
    expect(candidates.flatMap((candidate) => candidate.capture.inputs)).toEqual([own, otherStore]);
    await stopSession({ source: "restart", capture }).completed;
    expect(own.abortSignal.aborted).toBe(true);
    expect(sibling.abortSignal.aborted).toBe(false);
    expect(unbound.abortSignal.aborted).toBe(false);
    expect(otherStore.abortSignal.aborted).toBe(false);
    for (const input of [sibling, unbound, otherStore]) {
      retireSessionControllerInput(input);
    }
  });

  it("cancels captured injection work and waits for its native settlement", async () => {
    const f = fixture();
    const input = f.reserve("injecting");
    const injection = beginSessionControllerSourceInjection(input);
    expect(await injection.admit()).toBe(true);
    const capture = captureSessionControllerStop({ targets: [f.target], includeQueued: false });
    expect(capture.activeInputs).toEqual([input]);
    expect(capture.queuedInputs).toEqual([]);
    expect(
      captureSessionControllerStop({ targets: [f.target], includeActive: false }).inputs,
    ).not.toContain(input);
    try {
      const outcome = await stopSession({ source: "restart", capture }).completed;
      expect(outcome.activeCancelled).toBe(1);
      expect(input.abortSignal.aborted).toBe(true);
      let settled = false;
      void outcome.settled.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      injection.finish(false);
      await outcome.settled;
      expect(settled).toBe(true);
    } finally {
      injection.finish(false);
      retireSessionControllerInput(input);
    }
  });

  it("selects new pending input once within the captured physical target and Gateway", async () => {
    const f = fixture();
    const gateway = () => undefined;
    const siblingGateway = () => undefined;
    const reserve = (runId: string) =>
      withPluginRuntimeGatewayContextResolver(gateway, () => f.reserve(runId));
    const original = reserve("original");
    const capture = captureSessionControllerStop({
      targets: [f.target],
      resolveGatewayContext: gateway,
    });
    const later = reserve("later");
    const foreign = withPluginRuntimeGatewayContextResolver(gateway, () =>
      reserveSessionControllerSource(f.sessionKey, {
        target: captureSessionTarget({ ...f.target, incarnation: "replacement-session" }),
        protocolRunId: "replacement",
        policy: { mode: "followup" },
      }),
    );
    const sibling = withPluginRuntimeGatewayContextResolver(siblingGateway, () =>
      f.reserve("sibling"),
    );
    const reentrant: ReturnType<typeof reserve>[] = [];
    original.abortSignal.addEventListener("abort", () => reentrant.push(reserve("reentrant")), {
      once: true,
    });
    try {
      const outcome = await stopSession({ source: "restart", capture }).completed;
      expect(outcome.queuedCancelled).toBe(2);
      expect(original.abortSignal.aborted).toBe(true);
      expect(later.abortSignal.aborted).toBe(true);
      expect(foreign.abortSignal.aborted).toBe(false);
      expect(sibling.abortSignal.aborted).toBe(false);
      expect(reentrant).toHaveLength(1);
      expect(reentrant[0]?.abortSignal.aborted).toBe(false);
      await outcome.settled;
    } finally {
      for (const input of [original, later, foreign, sibling, ...reentrant]) {
        retireSessionControllerInput(input);
      }
    }
  });

  it("does not stop an external parent after a controller cancellation revokes authority", async () => {
    const f = fixture();
    const input = f.reserve("revocation");
    let current = true;
    input.abortSignal.addEventListener(
      "abort",
      () => {
        current = false;
      },
      { once: true },
    );
    const externalStop = vi.fn(() => "aborted" as const);
    const stop = stopSession({
      source: "restart",
      capture: captureSessionControllerStop({ inputs: [input] }),
      assertCurrent: () => {
        if (!current) {
          throw new Error("authority revoked");
        }
      },
      externalParent: { stop: externalStop },
    });
    await expect(stop.completed).rejects.toThrow("authority revoked");
    expect(input.abortSignal.aborted).toBe(true);
    expect(externalStop).not.toHaveBeenCalled();
  });

  it("does not fire the command hook if cutoff persistence revokes authority", async () => {
    const f = fixture();
    let current = true;
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    try {
      const stop = stopSession({
        source: "client-session",
        capture: captureSessionControllerStop({}),
        assertCurrent: () => {
          if (!current) {
            throw new Error("authority revoked");
          }
        },
        recordAbortTarget: async () => {
          current = false;
        },
        hookContext: { sessionKey: f.sessionKey },
      });
      await expect(stop.completed).rejects.toThrow("authority revoked");
      expect(hook).not.toHaveBeenCalled();
    } finally {
      unregisterInternalHook("command:stop", hook);
    }
  });

  it.each(policyCases)(
    "applies the %s policy",
    async (source, cancelQueued, stopsChildren, recordsCutoff, firesHook) => {
      const f = fixture();
      const active = f.reserve("active");
      const running = createDeferredCore();
      const release = createDeferredCore();
      const execution = withSessionTurn(
        {
          sessionKey: f.sessionKey,
          sessionId: f.sessionId,
          storePath: f.target.storeScope,
          controllerInput: active,
        },
        async () => {
          running.resolve();
          await release.promise;
        },
      );
      await running.promise;
      const queued = f.reserve("queued");
      const hookEvents: InternalHookEvent[] = [];
      const hook = vi.fn((event: InternalHookEvent) => {
        hookEvents.push(event);
      });
      registerInternalHook("command:stop", hook);
      const stopChildren = vi.fn(async (applyParentStop: () => Promise<boolean>) => {
        await applyParentStop();
        return { stopped: 2, failed: 1 };
      });
      const recordAbortTarget = vi.fn(async (_options: { recordCutoff: boolean }) => {});

      try {
        const outcome = await stopSession({
          source,
          capture: captureSessionControllerStop({ inputs: [active, queued] }),
          messageIdentity: { messageId: "m1" },
          recordAbortTarget,
          hookContext: firesHook
            ? {
                sessionKey: f.sessionKey,
                sessionId: f.sessionId,
                commandSource: "test-client",
                senderId: "sender-1",
              }
            : undefined,
          stopChildren,
        }).completed;

        expect(outcome.aborted).toBe(true);
        expect(outcome.alreadyFinalizing).toBe(false);
        expect(outcome.activeCancelled).toBe(1);
        if (source === "channel-user") {
          expect(isAgentRunDirectAbortReason(active.abortSignal.reason)).toBe(true);
        }
        expect(outcome.queuedCancelled).toBe(cancelQueued ? 1 : 0);
        expect(queued.abortSignal.aborted).toBe(cancelQueued);
        expect(stopChildren).toHaveBeenCalledTimes(stopsChildren ? 1 : 0);
        expect(outcome.childrenStopped).toBe(stopsChildren ? 2 : 0);
        expect(outcome.childFailures).toBe(stopsChildren ? 1 : 0);
        expect(recordAbortTarget).toHaveBeenCalledOnce();
        expect(recordAbortTarget).toHaveBeenCalledWith({ recordCutoff: recordsCutoff });
        expect(hook).toHaveBeenCalledTimes(firesHook ? 1 : 0);
        if (firesHook) {
          expect(hookEvents[0]).toMatchObject({
            type: "command",
            action: "stop",
            sessionKey: f.sessionKey,
            context: {
              sessionId: f.sessionId,
              commandSource: "test-client",
              senderId: "sender-1",
            },
          });
        }
      } finally {
        unregisterInternalHook("command:stop", hook);
        if (!queued.abortSignal.aborted) {
          retireSessionControllerInput(queued);
        }
        release.resolve();
        await execution.catch(() => undefined);
      }
    },
  );

  it("keeps user cleanup and the hook when the active run is already finishing", async () => {
    const f = fixture();
    const active = f.reserve("active");
    const running = createDeferredCore();
    const release = createDeferredCore();
    const execution = withSessionTurn(
      {
        sessionKey: f.sessionKey,
        sessionId: f.sessionId,
        storePath: f.target.storeScope,
        controllerInput: active,
      },
      async () => {
        running.resolve();
        await release.promise;
      },
    );
    await running.promise;
    active.claim?.operation?.freezeAbort();
    const queued = f.reserve("queued");
    const hook = vi.fn();
    registerInternalHook("command:stop", hook);
    const stopChildren = vi.fn(async (applyParentStop: () => Promise<boolean>) => {
      await applyParentStop();
      return { stopped: 1, failed: 0 };
    });

    try {
      const outcome = await stopSession({
        source: "channel-user",
        capture: captureSessionControllerStop({ inputs: [active, queued] }),
        hookContext: { sessionKey: f.sessionKey },
        stopChildren,
      }).completed;

      expect(outcome).toMatchObject({
        aborted: false,
        alreadyFinalizing: true,
        queuedCancelled: 1,
        activeCancelled: 0,
        childrenStopped: 1,
      });
      expect(queued.abortSignal.aborted).toBe(true);
      expect(active.abortSignal.aborted).toBe(false);
      expect(stopChildren).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledOnce();
    } finally {
      unregisterInternalHook("command:stop", hook);
      release.resolve();
      await execution;
    }
  });

  it("withdraws queued sources before signaling the active producer without stopping a successor", async () => {
    const f = fixture();
    const active = f.reserve("active");
    const running = createDeferredCore();
    const release = createDeferredCore();
    const execution = withSessionTurn(
      {
        sessionKey: f.sessionKey,
        sessionId: f.sessionId,
        storePath: f.target.storeScope,
        controllerInput: active,
      },
      async () => {
        running.resolve();
        await release.promise;
      },
    );
    await running.promise;
    const queued = f.reserve("queued");
    const capture = captureSessionControllerStop({ targets: [f.target] });
    let successor: ReturnType<typeof f.reserve> | undefined;
    let observedQueue = false;
    active.abortSignal.addEventListener(
      "abort",
      () => {
        observedQueue = queued.abortSignal.aborted;
        successor = f.reserve("successor");
      },
      { once: true },
    );
    const result = await stopSession({
      source: "client-session",
      capture,
      hookContext: {
        sessionKey: f.sessionKey,
      },
    }).completed;
    expect(observedQueue).toBe(true);
    expect(result.queuedCancelled).toBe(1);
    expect(result.activeCancelled).toBe(1);
    expect(successor?.abortSignal.aborted).toBe(false);
    release.resolve();
    await execution.catch(() => undefined);
    await capture.settled;
    if (successor) {
      retireSessionControllerInput(successor);
    }
  });

  it("does not escalate a cancellation-retired source into an aggregate operation Stop", async () => {
    const f = fixture();
    const source = f.reserve("collected-sibling");
    const running = createDeferredCore();
    const release = createDeferredCore();
    const execution = withSessionTurn(
      {
        sessionKey: f.sessionKey,
        sessionId: f.sessionId,
        storePath: f.target.storeScope,
        controllerInput: source,
      },
      async () => {
        running.resolve();
        await release.promise;
      },
    );
    await running.promise;
    retireSessionControllerSourceCancellation(source);
    const result = await stopSession({
      source: "client-run",
      capture: captureSessionControllerStop({ inputs: [source] }),
      hookContext: { sessionKey: f.sessionKey },
    }).completed;
    expect(result.activeCancelled + result.queuedCancelled).toBe(0);
    expect(source.claim?.operation?.abortSignal.aborted).toBe(false);
    release.resolve();
    await execution;
  });

  it("lets a publication adapter invoke only its exact once-guarded primitive", async () => {
    const f = fixture();
    const source = f.reserve("run");
    let signals = 0;
    source.abortSignal.addEventListener("abort", () => signals++);
    const result = await stopSession({
      source: "client-run",
      capture: captureSessionControllerStop({ inputs: [source] }),
      hookContext: { sessionKey: f.sessionKey },
      cancelInput: (_source, cancel) => {
        expect(cancel()).toBe(true);
        expect(cancel()).toBe(true);
        return false;
      },
    }).completed;
    expect(signals).toBe(1);
    expect(result.queuedCancelled).toBe(1);
  });

  it("revalidates authority before each adapter-owned cancellation", async () => {
    const f = fixture();
    const first = f.reserve("first");
    const second = f.reserve("second");
    let current = true;
    first.abortSignal.addEventListener("abort", () => {
      current = false;
    });

    await expect(
      stopSession({
        source: "client-session",
        capture: captureSessionControllerStop({ inputs: [first, second] }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester authority changed");
          }
        },
        hookContext: { sessionKey: f.sessionKey },
        cancelInput: (_input, cancel) => cancel(),
      }).completed,
    ).rejects.toThrow("requester authority changed");
    expect(first.abortSignal.aborted).toBe(true);
    expect(second.abortSignal.aborted).toBe(false);
    retireSessionControllerInput(second);
  });

  it.each(["reject", "continue"] as const)(
    "stops the active producer before reporting queued cleanup failure: %s",
    async (errorPolicy) => {
      const f = fixture();
      const active = f.reserve("active");
      const running = createDeferredCore();
      const release = createDeferredCore();
      const execution = withSessionTurn(
        {
          sessionKey: f.sessionKey,
          sessionId: f.sessionId,
          target: f.target,
          controllerInput: active,
        },
        async () => {
          running.resolve();
          await release.promise;
        },
      );
      await running.promise;
      const cleanupError = new Error("synthetic queued cancellation cleanup failure");
      const queued = reserveSessionControllerSource(f.sessionKey, {
        target: f.target,
        policy: { mode: "followup" },
        adapter: {
          cancel: () => {
            throw cleanupError;
          },
        },
      });

      try {
        const stop = stopSession({
          source: "client-session",
          capture: captureSessionControllerStop({ inputs: [active, queued] }),
          hookContext: { sessionKey: f.sessionKey },
          onError: errorPolicy === "continue" ? () => "continue" : undefined,
        });

        if (errorPolicy === "reject") {
          await expect(stop.completed).rejects.toBe(cleanupError);
        }
        const outcome = errorPolicy === "continue" ? await stop.completed : stop;

        expect(outcome.queuedCancelled).toBe(1);
        expect(outcome.activeCancelled).toBe(1);
        expect(active.abortSignal.aborted).toBe(true);
        expect(outcome.failures).toEqual([{ target: queued, error: cleanupError }]);
      } finally {
        release.resolve();
        await execution.catch(() => undefined);
      }
    },
  );
});
