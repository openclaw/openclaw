import { randomUUID } from "node:crypto";
import { expect, it, onTestFinished, vi } from "vitest";
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

function stopHook() {
  const hook = vi.fn<(event: InternalHookEvent) => void>();
  registerInternalHook("command:stop", hook);
  onTestFinished(() => unregisterInternalHook("command:stop", hook));
  return hook;
}

function fixture() {
  const sessionKey = "agent:main:stop-boundary";
  const sessionId = randomUUID();
  const target = captureSessionTarget({
    storeScope: "/synthetic/stop/" + sessionId,
    sessionKey,
    incarnation: sessionId,
    agentId: "main",
  });
  const reserve = (
    protocolRunId?: string,
    options: Partial<Parameters<typeof reserveSessionControllerSource>[1]> = {},
  ) => {
    const input = reserveSessionControllerSource(sessionKey, {
      target,
      protocolRunId,
      policy: { mode: "followup" },
      ...options,
    });
    onTestFinished(() => retireSessionControllerInput(input));
    return input;
  };
  const operation = (id: string = sessionId) => {
    const result = createReplyOperation({
      sessionKey,
      sessionId: id,
      resetTriggered: false,
      target: id === sessionId ? target : captureSessionTarget({ ...target, incarnation: id }),
    });
    onTestFinished(async () => {
      result.complete();
      await result.ownerSettlement;
    });
    return result;
  };
  const start = async (
    input: ReturnType<typeof reserve>,
    useTarget = false,
    afterRelease?: (signal: AbortSignal) => void,
  ) => {
    const running = createDeferredCore();
    const release = createDeferredCore();
    const execution = withSessionTurn(
      {
        sessionKey,
        sessionId,
        controllerInput: input,
        ...(useTarget ? { target } : { storePath: target.storeScope }),
      },
      async (_operation, signal) => {
        running.resolve();
        await release.promise;
        afterRelease?.(signal);
      },
    );
    await running.promise;
    onTestFinished(async () => {
      release.resolve();
      await execution.catch(() => undefined);
    });
    return { release, execution };
  };
  const effect = async (
    options: Omit<Parameters<typeof beginSessionEffect>[0], "target"> & {
      target?: typeof target;
    } = {},
  ) => {
    const result = await beginSessionEffect({ target, ...options });
    onTestFinished(async () => {
      result.release();
      await result.released;
    });
    return result;
  };
  const stop = (targets = [target]) =>
    stopSession({
      source: "restart",
      capture: captureSessionControllerStop({ targets }),
    }).completed;
  const gateway = () => {
    const resolver = () => undefined;
    return {
      resolver,
      reserve: (...args: Parameters<typeof reserve>) =>
        withPluginRuntimeGatewayContextResolver(resolver, () => reserve(...args)),
      capture: () =>
        captureSessionControllerStop({ targets: [target], resolveGatewayContext: resolver }),
    };
  };
  return { sessionKey, sessionId, target, reserve, operation, start, stop, effect, gateway };
}

const policyCases = [
  ["channel-user", true, true, true, true, false],
  ["client-session", true, true, false, true, false],
  ["client-run", true, true, false, true, false],
  ["interrupt", true, false, false, false, false],
  ["restart", true, false, false, false, false],
  ["watchdog", false, false, false, false, false],
  ["operator-revocation", true, false, false, false, false],
  ["supersede", false, false, false, false, false],
  ["channel-user", true, true, true, true, true],
] as const satisfies ReadonlyArray<
  readonly [SessionStopSource, boolean, boolean, boolean, boolean, boolean]
>;

it.each(["cancelled", "producer failure", "cleanup failure", "writer failure"] as const)(
  "separates the run outcome from retained Stop settlement: %s",
  async (scenario) => {
    const f = fixture();
    const retained = createDeferredCore();
    const input = f.reserve(undefined, {
      adapter: {
        onSettled: () => (scenario === "writer failure" ? undefined : retained.promise),
      },
    });
    if (scenario === "writer failure") {
      trackSessionControllerSourceWork(input, retained.promise);
    }
    const reason = createAgentRunDirectAbortError();
    const producerError = new Error("synthetic provider failure");
    const cleanupError = new Error("synthetic retained work failure");
    const { release: finish, execution } = await f.start(input, true, (signal) => {
      if (scenario === "producer failure") {
        throw producerError;
      }
      signal.throwIfAborted();
    });
    void execution.catch(() => {});
    const stop = stopSession({
      source: "client-run",
      capture: captureSessionControllerStop({ inputs: [input] }),
      reason,
      hookContext: { sessionKey: f.sessionKey },
    });
    const settled = vi.fn();
    void stop.settled.then(settled, settled);
    try {
      expect(await stop.completed).toMatchObject({ aborted: true, activeCancelled: 1 });
      finish.resolve();
      await expect(execution).rejects.toBe(
        scenario === "producer failure" ? producerError : reason,
      );
      expect(settled).not.toHaveBeenCalled();
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

it.each(["effect", "operation", "native input"] as const)(
  "leaves a replacement %s running when Stop names an older incarnation",
  async (kind) => {
    const f = fixture();
    const replacement = captureSessionTarget({ ...f.target, incarnation: randomUUID() });
    const onInterrupt = vi.fn();
    const effect =
      kind === "effect" ? await f.effect({ target: replacement, onInterrupt }) : undefined;
    const operation = kind === "operation" ? f.operation(replacement.incarnation) : undefined;
    const input =
      kind === "native input" ? f.reserve(undefined, { target: replacement }) : undefined;
    const injection = input && beginSessionControllerSourceInjection(input);
    if (input && injection) {
      expect(await injection.admit()).toBe(true);
      onTestFinished(async () => {
        injection.finish(false);
        retireSessionControllerInput(input);
        await input.settlement.promise;
      });
    }
    expect(await f.stop()).toMatchObject({ aborted: false, activeCancelled: 0 });
    if (effect) {
      expect(onInterrupt).not.toHaveBeenCalled();
      expect(effect.isActive()).toBe(true);
      expect(await f.stop([replacement])).toMatchObject({ aborted: true, activeCancelled: 1 });
      expect(onInterrupt).toHaveBeenCalledOnce();
      expect(effect.isActive()).toBe(false);
      effect.release();
      await effect.released;
    } else {
      expect((operation ?? input)?.abortSignal.aborted).toBe(false);
    }
  },
);

it("still stops an operation through an incarnation it owns after rollover", async () => {
  const f = fixture();
  const operation = f.operation();
  operation.updateSessionId(randomUUID());
  const outcome = await f.stop();
  expect(outcome).toMatchObject({ aborted: true, activeCancelled: 1 });
  expect(operation.abortSignal.aborted).toBe(true);
});

it("cancels scoped runless effects without waiting for their producer release", async () => {
  const f = fixture();
  const gateway = () => undefined;
  const siblingGateway = () => undefined;
  const ownInterrupt = vi.fn();
  const siblingInterrupt = vi.fn();
  const own = await f.effect({
    resolveGatewayContext: gateway,
    onInterrupt: ownInterrupt,
  });
  await f.effect({
    resolveGatewayContext: siblingGateway,
    onInterrupt: siblingInterrupt,
  });
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
  const settled = vi.fn();
  void outcome.settled.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  own.release();
  await outcome.settled;
  expect(settled).toHaveBeenCalledOnce();
});

it("retains committed effect cancellation when its observer throws", async () => {
  const f = fixture();
  const failure = new Error("producer interruption observer failed");
  const admission = await f.effect({
    onInterrupt: () => {
      throw failure;
    },
  });
  const capture = captureSessionControllerStop({ targets: [f.target] });
  const execution = stopSession({ source: "restart", capture });
  expect(execution).toMatchObject({ aborted: true, activeCancelled: 1 });
  await expect(execution.completed).rejects.toThrow(failure);
  expect(execution.failures).toEqual([{ target: capture.effects[0], error: failure }]);
  expect(admission.isActive()).toBe(false);
});

it("selects only the captured Gateway and physical store, excluding unbound sources", async () => {
  const f = fixture();
  const gateway = f.gateway();
  const siblingGateway = f.gateway();
  const own = gateway.reserve("own");
  const sibling = siblingGateway.reserve("sibling");
  const unbound = f.reserve("unbound");
  const otherStore = gateway.reserve("other-store", {
    target: captureSessionTarget({ ...f.target, storeScope: f.target.storeScope + "/other" }),
  });
  const capture = gateway.capture();
  expect(capture.inputs).toEqual([own]);
  expect(
    captureSessionControllerStop({
      targets: [f.target],
      resolveGatewayContext: undefined,
    }).inputs,
  ).toEqual([unbound]);
  const candidates = captureSessionControllerStopCandidates({
    resolveGatewayContext: gateway.resolver,
  });
  expect(candidates.flatMap((candidate) => candidate.capture.inputs)).toEqual([own, otherStore]);
  await stopSession({ source: "restart", capture }).completed;
  const aborted = [own, sibling, unbound, otherStore].map((input) => input.abortSignal.aborted);
  expect(aborted).toEqual([true, false, false, false]);
});

it("cancels captured injection work and waits for its native settlement", async () => {
  const f = fixture();
  const input = f.reserve("injecting");
  const injection = beginSessionControllerSourceInjection(input);
  expect(await injection.admit()).toBe(true);
  onTestFinished(() => injection.finish(false));
  const capture = captureSessionControllerStop({ targets: [f.target], includeQueued: false });
  expect([capture.activeInputs, capture.queuedInputs]).toEqual([[input], []]);
  expect(
    captureSessionControllerStop({ targets: [f.target], includeActive: false }).inputs,
  ).not.toContain(input);
  const outcome = await stopSession({ source: "restart", capture }).completed;
  expect(outcome.activeCancelled).toBe(1);
  expect(input.abortSignal.aborted).toBe(true);
  const settled = vi.fn();
  void outcome.settled.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  injection.finish(false);
  await outcome.settled;
  expect(settled).toHaveBeenCalledOnce();
});

it("selects new pending input once within the captured physical target and Gateway", async () => {
  const f = fixture();
  const gateway = f.gateway();
  const original = gateway.reserve("original");
  const capture = gateway.capture();
  const later = gateway.reserve("later");
  const foreign = gateway.reserve("replacement", {
    target: captureSessionTarget({ ...f.target, incarnation: "replacement-session" }),
  });
  const sibling = f.gateway().reserve("sibling");
  const reentrant: ReturnType<typeof gateway.reserve>[] = [];
  original.abortSignal.addEventListener(
    "abort",
    () => reentrant.push(gateway.reserve("reentrant")),
    {
      once: true,
    },
  );
  const outcome = await stopSession({ source: "restart", capture }).completed;
  expect(outcome.queuedCancelled).toBe(2);
  const aborted = [original, later, foreign, sibling].map((input) => input.abortSignal.aborted);
  expect(aborted).toEqual([true, true, false, false]);
  expect(reentrant).toHaveLength(1);
  expect(reentrant[0]?.abortSignal.aborted).toBe(false);
  await outcome.settled;
});

it.each(["external parent", "command hook", "next input"] as const)(
  "revalidates authority before the %s effect",
  async (stage) => {
    const f = fixture();
    const inputs = stage === "command hook" ? [] : [f.reserve("first")];
    if (stage === "next input") {
      inputs.push(f.reserve("second"));
    }
    let current = true;
    inputs[0]?.abortSignal.addEventListener("abort", () => {
      current = false;
    });
    const externalStop = vi.fn(() => "aborted" as const);
    const hook = stage === "command hook" ? stopHook() : undefined;
    const message = stage === "next input" ? "requester authority changed" : "authority revoked";
    const stop = stopSession({
      source: stage === "external parent" ? "restart" : "client-session",
      capture: captureSessionControllerStop({ inputs }),
      assertCurrent: () => {
        if (!current) {
          throw new Error(message);
        }
      },
      hookContext: { sessionKey: f.sessionKey },
      ...(stage === "external parent" ? { externalParent: { stop: externalStop } } : {}),
      ...(stage === "command hook"
        ? {
            recordAbortTarget: async () => {
              current = false;
            },
          }
        : {}),
      cancelInput: stage === "next input" ? (_input, cancel) => cancel() : undefined,
    });
    await expect(stop.completed).rejects.toThrow(message);
    if (stage === "command hook") {
      expect(hook).not.toHaveBeenCalled();
    } else {
      expect(inputs[0]?.abortSignal.aborted).toBe(true);
      if (stage === "external parent") {
        expect(externalStop).not.toHaveBeenCalled();
      } else {
        expect(inputs[1]?.abortSignal.aborted).toBe(false);
      }
    }
  },
);

it.each(policyCases)(
  "applies %s policy (queued=%s, children=%s, cutoff=%s, hook=%s, finishing=%s)",
  async (source, cancelQueued, stopsChildren, recordsCutoff, firesHook, finishing) => {
    const f = fixture();
    const active = f.reserve("active");
    const { release, execution } = await f.start(active);
    if (finishing) {
      active.claim?.operation?.freezeAbort();
    }
    const queued = f.reserve("queued");
    const hook = stopHook();
    const stopChildren = vi.fn(async (applyParentStop: () => Promise<boolean>) => {
      await applyParentStop();
      return { stopped: finishing ? 1 : 2, failed: finishing ? 0 : 1 };
    });
    const recordAbortTarget = vi.fn(async (_options: { recordCutoff: boolean }) => {});
    const hookMetadata = finishing
      ? {}
      : {
          sessionId: f.sessionId,
          commandSource: "test-client",
          senderId: "sender-1",
        };

    const outcome = await stopSession({
      source,
      capture: captureSessionControllerStop({ inputs: [active, queued] }),
      messageIdentity: finishing ? undefined : { messageId: "m1" },
      recordAbortTarget: finishing ? undefined : recordAbortTarget,
      hookContext: firesHook ? { sessionKey: f.sessionKey, ...hookMetadata } : undefined,
      stopChildren,
    }).completed;

    expect(outcome).toMatchObject({
      aborted: !finishing,
      alreadyFinalizing: finishing,
      activeCancelled: finishing ? 0 : 1,
      queuedCancelled: cancelQueued ? 1 : 0,
      childrenStopped: stopsChildren ? (finishing ? 1 : 2) : 0,
      childFailures: stopsChildren && !finishing ? 1 : 0,
    });
    expect(active.abortSignal.aborted).toBe(!finishing);
    if (source === "channel-user" && !finishing) {
      expect(isAgentRunDirectAbortReason(active.abortSignal.reason)).toBe(true);
    }
    expect(queued.abortSignal.aborted).toBe(cancelQueued);
    expect(stopChildren).toHaveBeenCalledTimes(stopsChildren ? 1 : 0);
    if (!finishing) {
      expect(recordAbortTarget).toHaveBeenCalledExactlyOnceWith({ recordCutoff: recordsCutoff });
    }
    expect(hook).toHaveBeenCalledTimes(firesHook ? 1 : 0);
    if (firesHook) {
      expect(hook.mock.calls[0]?.[0]).toMatchObject({
        type: "command",
        action: "stop",
        sessionKey: f.sessionKey,
        context: hookMetadata,
      });
    }
    release.resolve();
    await (finishing ? execution : execution.catch(() => undefined));
  },
);

it("withdraws queued sources before signaling the active producer without stopping a successor", async () => {
  const f = fixture();
  const active = f.reserve("active");
  const { release, execution } = await f.start(active);
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
    hookContext: { sessionKey: f.sessionKey },
  }).completed;
  expect(observedQueue).toBe(true);
  expect(result).toMatchObject({ queuedCancelled: 1, activeCancelled: 1 });
  expect(successor?.abortSignal.aborted).toBe(false);
  release.resolve();
  await execution.catch(() => undefined);
  await capture.settled;
});

it("does not escalate a cancellation-retired source into an aggregate operation Stop", async () => {
  const f = fixture();
  const source = f.reserve("collected-sibling");
  const { release, execution } = await f.start(source);
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

it.each(["reject", "continue"] as const)(
  "stops the active producer before reporting queued cleanup failure: %s",
  async (errorPolicy) => {
    const f = fixture();
    const active = f.reserve("active");
    await f.start(active, true);
    const cleanupError = new Error("synthetic queued cancellation cleanup failure");
    const queued = f.reserve(undefined, {
      adapter: {
        cancel: () => {
          throw cleanupError;
        },
      },
    });

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

    expect(outcome).toMatchObject({ queuedCancelled: 1, activeCancelled: 1 });
    expect(active.abortSignal.aborted).toBe(true);
    expect(outcome.failures).toEqual([{ target: queued, error: cleanupError }]);
  },
);
