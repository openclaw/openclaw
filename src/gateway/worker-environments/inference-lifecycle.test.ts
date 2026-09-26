import { describe, expect, it, vi } from "vitest";
import type {
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleChatAbortRequestWithLifecycle } from "../server-methods/chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../server-methods/chat.abort.test-helpers.js";
import { registerWorkerInferenceSessionControl } from "./inference-control-internal.js";
import type { WorkerInferenceExecutor } from "./inference.js";
import {
  accept,
  CANCEL,
  createMemoryStore,
  createSink,
  DONE,
  ERROR,
  IDENTITY,
  identityFor,
  makeManager,
  type Manager,
  REQUEST,
  SESSION_TARGET,
  terminalFrames,
  waitForFast,
} from "./inference.test-support.js";

describe("worker inference manager", () => {
  it("keeps a late launch inside an accepted drain before deferred start", async () => {
    const execute = vi.fn<WorkerInferenceExecutor>(async () => DONE);
    const instance = makeManager(execute);
    const accepted = await accept(instance, {}, false);
    const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
    accepted.launch();
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(drain.hasWork()).toBe(true);
    drain.start();
    await drain.drained;
    expect(execute).not.toHaveBeenCalled();
    expect(drain.hasWork()).toBe(false);
    drain.release();
    await instance.stop();
  });

  it.each(["authority-refused", "outcome-unknown"] as const)(
    "reconciles cancellation during a pending terminal write only after %s",
    async (failureKind) => {
      const entered = createDeferred();
      const release = createDeferred();
      const failure = new Error("terminal commit outcome unavailable", {
        cause: new SqliteWorkerError("terminal result lost", "outcome-unknown"),
      });
      const store = createMemoryStore();
      let first = true;
      const complete = vi
        .spyOn(store, "complete")
        .mockImplementation(async (input, assertCurrent) => {
          if (first) {
            first = false;
            expect(input.outcome).toEqual(DONE);
            entered.resolve();
            await release.promise;
            if (failureKind === "outcome-unknown") {
              throw failure;
            }
          }
          // The known refusal comes from the manager's actual pre-commit guard.
          assertCurrent?.();
          return input.outcome;
        });
      const sink = createSink();
      const instance = makeManager(async () => DONE, store);
      await accept(instance, { sink: sink.sink });
      await entered.promise;
      const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      const joined =
        failureKind === "outcome-unknown"
          ? expect(drain.drained).rejects.toBe(failure)
          : expect(drain.drained).resolves.toBeUndefined();
      const cancelled = instance.cancel({ identity: IDENTITY, request: CANCEL });
      drain.start();
      release.resolve();
      expect(await cancelled).toEqual(
        failureKind === "outcome-unknown"
          ? { ok: false, reason: "provider-error" }
          : { ok: true, result: { status: "cancelled" } },
      );
      await joined;
      expect(complete).toHaveBeenCalledTimes(failureKind === "outcome-unknown" ? 1 : 2);
      drain.release();
      if (failureKind === "outcome-unknown") {
        expect(terminalFrames(sink.frames)).toEqual([]);
        await expect(instance.stop()).rejects.toBe(failure);
      } else {
        expect(terminalFrames(sink.frames)).toHaveLength(1);
        expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
          reason: "cancelled",
        });
        await instance.stop();
      }
    },
  );

  it.each(["session", "environment"] as const)(
    "%s cancellation does not adopt a successor admitted by terminal delivery",
    async (kind) => {
      const instance = makeManager(async ({ signal }) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
          } else {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        return ERROR;
      });
      const frames: WorkerInferenceTerminalFrame[] = [];
      const replacementRequest = { ...REQUEST, turnId: "successor-turn" };
      const successor = createSink("successor");
      let successorStart: ReturnType<typeof accept> | undefined;
      await accept(instance, {
        sink: {
          connectionId: "original",
          send: (frame) => {
            if (frame.event !== "worker.inference.terminal") {
              return;
            }
            frames.push(frame);
            successorStart = accept(
              instance,
              { request: replacementRequest, sink: successor.sink },
              false,
            );
          },
        },
      });
      try {
        if (kind === "session") {
          expect(await instance.cancelSession(REQUEST.sessionId)).toEqual([REQUEST.runId]);
        } else {
          await instance.cancelEnvironment(IDENTITY.environmentId);
        }
        await successorStart;
        expect(frames).toHaveLength(1);
        expect(frames[0]?.payload.turnId).toBe(REQUEST.turnId);
        expect(terminalFrames(successor.frames)).toEqual([]);
        expect(instance.hasSession(REQUEST.sessionId, REQUEST.runId)).toBe(true);
      } finally {
        await instance.stop();
      }
    },
  );

  it("records accepted worker cancellation and never adopts its callback's successor", async () => {
    const instance = makeManager(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }
      });
      return ERROR;
    });
    const successor = createSink("successor");
    let successorStart: ReturnType<typeof accept> | undefined;
    let current = true;
    await accept(instance, {
      sink: {
        connectionId: "original",
        send: (frame) => {
          if (frame.event !== "worker.inference.terminal") {
            return;
          }
          current = false;
          successorStart = accept(
            instance,
            {
              request: { ...REQUEST, turnId: "successor-turn" },
              sink: successor.sink,
            },
            false,
          );
        },
      },
    });
    const captured = instance.captureSessionCancellation(REQUEST.sessionId);
    const committed: string[] = [];
    try {
      expect(
        await captured.cancel({
          assertCurrent: () => {
            if (!current) {
              throw new Error("source revoked");
            }
          },
          onCancelled: (runId) => committed.push(runId),
        }),
      ).toEqual([REQUEST.runId]);
      await successorStart;
      expect(committed).toEqual([REQUEST.runId]);
      expect(terminalFrames(successor.frames)).toEqual([]);
      expect(await captured.cancel()).toEqual([]);
      expect(instance.hasSession(REQUEST.sessionId, REQUEST.runId)).toBe(true);
    } finally {
      await instance.stop();
    }
  });

  it.each([false, true])(
    "Gateway Stop retains original worker registration and authority (explicit=%s)",
    async (explicit) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        for (const change of ["none", "replacement", "revocation"] as const) {
          const key = "agent:main:main";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: key },
            {
              sessionId: explicit ? "requested-session" : REQUEST.sessionId,
              updatedAt: 1,
            },
          );
          const signals: AbortSignal[] = [];
          const instance = makeManager(({ signal }) => {
            signals.push(signal);
            return new Promise((resolve) => {
              signal.addEventListener("abort", () => resolve(ERROR), { once: true });
            });
          });
          const workerService = {};
          registerWorkerInferenceSessionControl(workerService, {
            reserveDrain: instance.reserveSessionDrain,
            captureCancel: instance.captureSessionCancellation,
            resolveTarget: instance.resolveSessionTargetForRunId,
          });
          const original = createSink();
          const successor = createSink("successor");
          let successorStart: Promise<unknown> | undefined;
          await accept(instance, { sink: original.sink });
          let current = true;
          const parent = createActiveRun(explicit ? "agent:main:other" : key, {
            sessionId: REQUEST.sessionId,
            agentId: "main",
            owner: { connId: "worker-owner" },
          });
          parent.controller.signal.addEventListener(
            "abort",
            () => {
              if (change === "revocation") {
                current = false;
              }
              if (change === "replacement") {
                successorStart = instance.cancelSession(REQUEST.sessionId, REQUEST.runId).then(() =>
                  accept(
                    instance,
                    {
                      request: { ...REQUEST, turnId: "successor-turn" },
                      sink: successor.sink,
                    },
                    false,
                  ),
                );
              }
            },
            { once: true },
          );
          const context = createChatAbortContext({
            chatAbortControllers: new Map([[REQUEST.runId, parent]]),
            workerEnvironmentService: workerService,
          });
          try {
            await waitForFast(() => expect(signals).toHaveLength(1));
            const stopped = invokeChatAbortHandler({
              handler: (options) =>
                handleChatAbortRequestWithLifecycle({
                  ...options,
                  hasCurrentClientAuthority: () => current,
                }),
              context,
              request: { sessionKey: key, ...(explicit ? { runId: REQUEST.runId } : {}) },
              client: { connId: "worker-owner", connect: { scopes: ["operator.admin"] } },
            });
            if (change === "revocation") {
              await expect(stopped).rejects.toThrow("requester authority changed");
            } else {
              const response = await stopped;
              expect(response.mock.calls[0]?.[1]).toMatchObject({
                aborted: true,
                runIds: [REQUEST.runId],
              });
            }
            await successorStart;
            expect(parent.controller.signal.aborted).toBe(true);
            expect(signals[0]?.aborted).toBe(change !== "revocation");
            expect(instance.hasSession(REQUEST.sessionId, REQUEST.runId)).toBe(change !== "none");
            expect(terminalFrames(original.frames)).toHaveLength(change === "revocation" ? 0 : 1);
            expect(terminalFrames(successor.frames)).toEqual([]);
          } finally {
            await instance.stop();
          }
        }
      });
    },
  );

  it("cancels the provider idempotently", async () => {
    const store = createMemoryStore();
    const signals: AbortSignal[] = [];
    const pending = [
      createDeferred<WorkerInferenceTerminalOutcome>(),
      createDeferred<WorkerInferenceTerminalOutcome>(),
    ];
    const instance = makeManager(({ signal }) => {
      signals.push(signal);
      const execution = pending[signals.length - 1];
      if (!execution) {
        throw new Error("unexpected inference execution");
      }
      signal.addEventListener("abort", () => execution.resolve(ERROR), { once: true });
      return execution.promise;
    }, store);
    const sink = createSink();
    await accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(signals).toHaveLength(1));
    for (let index = 0; index < 2; index += 1) {
      expect(await instance.cancel({ identity: IDENTITY, request: CANCEL })).toEqual({
        ok: true,
        result: { status: "cancelled" },
      });
    }
    expect(signals[0]?.aborted).toBe(true);
    const nextRequest = { ...REQUEST, runId: "new-run", turnId: "new-turn" };
    await accept(instance, { identity: identityFor(nextRequest), request: nextRequest });
    await waitForFast(() => expect(signals).toHaveLength(2));
    expect(await instance.cancelSession(REQUEST.sessionId, "new-run")).toEqual(["new-run"]);
    expect(signals[1]?.aborted).toBe(true);
    await instance.stop();
  });

  it("blocks replacement inference until an exact session drain settles", async () => {
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const execute = vi.fn<WorkerInferenceExecutor>(async () => await pending.promise);
    const instance = makeManager(execute);
    await accept(instance);
    await waitForFast(() => expect(execute).toHaveBeenCalledOnce());

    const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
    drain.start();
    expect(drain.hasWork()).toBe(true);
    const replacementRequest = { ...REQUEST, runId: "replacement", turnId: "replacement" };
    const replacementIdentity = identityFor(replacementRequest);
    expect(
      await instance.start({
        sessionTarget: SESSION_TARGET,
        identity: replacementIdentity,
        request: replacementRequest,
        sink: createSink().sink,
      }),
    ).toEqual({ ok: false, reason: "cancelled" });

    pending.resolve(ERROR);
    await drain.drained;
    expect(drain.hasWork()).toBe(false);
    drain.release();
    expect(
      await instance.start({
        sessionTarget: SESSION_TARGET,
        identity: replacementIdentity,
        request: replacementRequest,
        sink: createSink().sink,
      }),
    ).toMatchObject({ ok: true });
    await instance.stop();
  });

  it.each(["write-failed", "outcome-unknown"] as const)(
    "preserves the original %s persistence failure through an inference drain",
    async (failureKind) => {
      const failure =
        failureKind === "outcome-unknown"
          ? new Error("terminal settlement failed", {
              cause: new AggregateError(
                [new SqliteWorkerError("worker result lost", "outcome-unknown")],
                "worker cleanup",
              ),
            })
          : new Error("write failed");
      const store = createMemoryStore();
      const complete = vi.spyOn(store, "complete").mockRejectedValue(failure);
      const pending = createDeferred<WorkerInferenceTerminalOutcome>();
      const entered = createDeferred();
      const instance = makeManager(async () => {
        entered.resolve();
        return await pending.promise;
      }, store);
      const sink = createSink();
      await accept(instance, { sink: sink.sink });
      await entered.promise;

      const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      const rejected = expect(drain.drained).rejects.toBe(failure);
      drain.start();
      const cancelled = instance.cancel({ identity: IDENTITY, request: CANCEL });
      pending.resolve(ERROR);
      expect(await cancelled).toEqual({ ok: false, reason: "provider-error" });
      await rejected;
      expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(failureKind === "outcome-unknown");
      expect(complete).toHaveBeenCalledOnce();
      expect(terminalFrames(sink.frames)).toEqual([]);
      drain.release();
      await expect(instance.stop()).rejects.toBe(failure);
    },
  );

  it.each(["provider-error", "outcome-unknown"] as const)(
    "retains the original executor %s in an accepted drain",
    async (failureKind) => {
      const failure =
        failureKind === "outcome-unknown"
          ? new Error("provider native work failed", {
              cause: new SqliteWorkerError("native result lost", "outcome-unknown"),
            })
          : new Error("upstream unavailable");
      const provider = createDeferred<WorkerInferenceTerminalOutcome>();
      const entered = createDeferred();
      const instance = makeManager(async () => {
        entered.resolve();
        return await provider.promise;
      });
      await accept(instance);
      await entered.promise;
      const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      const rejected = expect(drain.drained).rejects.toBe(failure);
      drain.start();
      provider.reject(failure);
      await rejected;
      expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(failureKind === "outcome-unknown");
      drain.release();
      if (failureKind === "outcome-unknown") {
        await expect(instance.stop()).rejects.toBe(failure);
      } else {
        await instance.stop();
      }
    },
  );

  it("retains a provider captured by a drain inside synchronous executor entry", async () => {
    type AcceptedDrain = ReturnType<ReturnType<Manager["reserveSessionDrain"]>["accept"]>;
    const failure = new Error("provider failed after reentrant drain acceptance");
    const provider = createDeferred<WorkerInferenceTerminalOutcome>();
    const entered = createDeferred<AcceptedDrain>();
    const store = createMemoryStore();
    const complete = vi.spyOn(store, "complete");
    let drain: AcceptedDrain | undefined;
    const instance: Manager = makeManager(async () => {
      drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      drain.start();
      entered.resolve(drain);
      return await provider.promise;
    }, store);
    const sink = createSink();
    try {
      await accept(instance, { sink: sink.sink });
      const accepted = await entered.promise;
      const drained = Promise.allSettled([accepted.drained]);
      expect(await sink.terminal).toMatchObject({ payload: { outcome: { reason: "cancelled" } } });
      expect(complete).toHaveBeenCalledOnce();
      provider.reject(failure);
      const [outcome] = await drained;
      if (outcome.status !== "rejected") {
        throw new Error("reentrant drain lost the provider registered after executor entry");
      }
      expect(outcome.reason).toBe(failure);
      expect(complete).toHaveBeenCalledOnce();
      expect(terminalFrames(sink.frames)).toHaveLength(1);
    } finally {
      drain?.start();
      if (drain) {
        provider.reject(failure);
      } else {
        provider.resolve(ERROR);
      }
      await Promise.allSettled([drain?.drained, instance.stop()]);
      drain?.release();
    }
  });

  it("defers protocol cancellation to the accepted drain and joins its provider work", async () => {
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const entered = createDeferred<AbortSignal>();
    const store = createMemoryStore();
    const complete = vi.spyOn(store, "complete");
    const cancelPending = vi.spyOn(store, "cancelPending");
    const instance = makeManager(async ({ signal }) => {
      entered.resolve(signal);
      return await pending.promise;
    }, store);
    const sink = createSink();
    await accept(instance, { sink: sink.sink });
    const signal = await entered.promise;
    const reservation = instance.reserveSessionDrain(REQUEST.sessionId);
    reservation.assertReserved();
    const drain = reservation.accept();
    let cancellationSettled = false;
    const cancelled = instance.cancel({ identity: IDENTITY, request: CANCEL });
    void cancelled.then(() => {
      cancellationSettled = true;
    });
    let settled = false;
    const joined = drain.drained.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(signal.aborted).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(cancellationSettled).toBe(false);
    expect(cancelPending).not.toHaveBeenCalled();

    drain.start();
    drain.start();
    expect(signal.aborted).toBe(true);
    expect(drain.hasWork()).toBe(true);
    await sink.terminal;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cancellationSettled).toBe(false);
    pending.resolve(DONE);
    await joined;
    expect(await cancelled).toEqual({ ok: true, result: { status: "cancelled" } });
    expect(await instance.cancel({ identity: IDENTITY, request: CANCEL })).toEqual({
      ok: true,
      result: { status: "cancelled" },
    });
    expect(cancelPending).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminalFrames(sink.frames)).toHaveLength(1);
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({ reason: "cancelled" });
    expect(drain.hasWork()).toBe(false);
    drain.release();
    await instance.stop();
  });

  it("does not let a stale drain release unlock a newer accepted drain", async () => {
    const store = createMemoryStore();
    const begin = vi.spyOn(store, "begin");
    const instance = makeManager(async () => DONE, store);
    const previous = instance.reserveSessionDrain(REQUEST.sessionId).accept();
    previous.start();
    await previous.drained;
    previous.release();
    const current = instance.reserveSessionDrain(REQUEST.sessionId).accept();
    const start = () =>
      instance.start({
        identity: IDENTITY,
        request: REQUEST,
        sessionTarget: SESSION_TARGET,
        sink: createSink().sink,
      });
    try {
      previous.release();
      previous.release();
      expect(await start()).toEqual({ ok: false, reason: "cancelled" });
      current.start();
      await current.drained;
      previous.release();
      expect(await start()).toEqual({ ok: false, reason: "cancelled" });
      expect(begin).not.toHaveBeenCalled();
      current.release();
      expect(await start()).toMatchObject({ ok: true, result: { status: "accepted" } });
      expect(begin).toHaveBeenCalledOnce();
    } finally {
      current.start();
      await current.drained;
      current.release();
      await instance.stop();
    }
  });

  it("waits for an accepted drain to start before shutdown persists its turn", async () => {
    const failure = new Error("reserved terminal outcome unavailable", {
      cause: new SqliteWorkerError("reserved native outcome unknown", "outcome-unknown"),
    });
    const otherRequest = {
      ...REQUEST,
      sessionId: "unrelated-shutdown-session",
      runId: "unrelated-shutdown-run",
      turnId: "unrelated-shutdown-turn",
    };
    const otherEntered = createDeferred<AbortSignal>();
    const otherProvider = createDeferred<WorkerInferenceTerminalOutcome>();
    const store = createMemoryStore();
    const complete = vi.spyOn(store, "complete").mockImplementation(async (input) => {
      if (input.sessionId === REQUEST.sessionId) {
        throw failure;
      }
      return input.outcome;
    });
    const execute = vi.fn<WorkerInferenceExecutor>(async ({ request, signal }) => {
      if (request.sessionId !== otherRequest.sessionId) {
        throw new Error("reserved provider must remain unlaunched");
      }
      otherEntered.resolve(signal);
      return await otherProvider.promise;
    });
    const instance = makeManager(execute, store);
    const reservedSink = createSink("reserved");
    await accept(instance, { sink: reservedSink.sink }, false);
    const otherSink = createSink("unrelated");
    const other = await instance.start({
      identity: identityFor(otherRequest),
      request: otherRequest,
      sessionTarget: { ...SESSION_TARGET, sessionId: otherRequest.sessionId },
      sink: otherSink.sink,
    });
    if (!other.ok) {
      throw new Error(`unrelated inference failed to start: ${other.reason}`);
    }
    other.launch();
    const otherSignal = await otherEntered.promise;
    const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
    const drained = Promise.allSettled([drain.drained]);
    const stopping = instance.stop();
    const stopped = Promise.allSettled([stopping]);
    let stopSettled = false;
    void stopping.then(
      () => {
        stopSettled = true;
      },
      () => {
        stopSettled = true;
      },
    );
    try {
      expect(otherSignal.aborted).toBe(true);
      expect((await otherSink.terminal).payload.outcome).toMatchObject({
        reason: "provider-error",
      });
      expect(complete.mock.calls.map(([input]) => input.sessionId)).toEqual([
        otherRequest.sessionId,
      ]);
      expect(reservedSink.frames).toEqual([]);
      expect(instance.hasSession(REQUEST.sessionId)).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(stopSettled).toBe(false);

      drain.start();
      const [drainResult] = await drained;
      if (drainResult.status !== "rejected") {
        throw new Error("reserved drain lost its terminal persistence failure");
      }
      expect(drainResult.reason).toBe(failure);
      expect(complete.mock.calls.map(([input]) => input.sessionId)).toEqual([
        otherRequest.sessionId,
        REQUEST.sessionId,
      ]);
      expect(complete.mock.calls[1]?.[0].outcome).toMatchObject({ reason: "cancelled" });
      expect(stopSettled).toBe(false);
      expect(reservedSink.frames).toEqual([]);
      otherProvider.resolve(ERROR);
      const [stopResult] = await stopped;
      if (stopResult.status !== "rejected") {
        throw new Error("shutdown did not join the accepted drain's original failure");
      }
      expect(stopResult.reason).toBe(failure);
      expect(instance.stop()).toBe(stopping);
      expect(complete).toHaveBeenCalledTimes(2);
    } finally {
      drain.start();
      otherProvider.resolve(ERROR);
      await Promise.allSettled([drain.drained, instance.stop()]);
      drain.release();
    }
  });

  it("shares shutdown ownership with reentrant and later protocol cancellation", async () => {
    const entered = createDeferred();
    const provider = createDeferred<WorkerInferenceTerminalOutcome>();
    const store = createMemoryStore();
    const complete = vi.spyOn(store, "complete");
    const cancelPending = vi.spyOn(store, "cancelPending");
    let reentrantStop: Promise<void> | undefined;
    let reentrantCancel: ReturnType<Manager["cancel"]> | undefined;
    const instance: Manager = makeManager(async ({ signal }) => {
      signal.addEventListener(
        "abort",
        () => {
          reentrantStop = instance.stop();
          reentrantCancel = instance.cancel({ identity: IDENTITY, request: CANCEL });
        },
        { once: true },
      );
      entered.resolve();
      return await provider.promise;
    }, store);
    const sink = createSink();
    await accept(instance, { sink: sink.sink });
    await entered.promise;
    const stopping = instance.stop();
    try {
      expect(reentrantStop).toBe(stopping);
      expect(instance.stop()).toBe(stopping);
      const laterCancel = instance.cancel({ identity: IDENTITY, request: CANCEL });
      let cancellationsSettled = false;
      const cancellations = Promise.all([reentrantCancel, laterCancel]).then((results) => {
        cancellationsSettled = true;
        return results;
      });
      await sink.terminal;
      expect(cancellationsSettled).toBe(false);
      expect(cancelPending).not.toHaveBeenCalled();
      provider.resolve(ERROR);
      await stopping;
      expect(await cancellations).toEqual([
        { ok: true, result: { status: "cancelled" } },
        { ok: true, result: { status: "cancelled" } },
      ]);
      expect(instance.stop()).toBe(stopping);
      expect(await instance.cancel({ identity: IDENTITY, request: CANCEL })).toEqual({
        ok: true,
        result: { status: "cancelled" },
      });
      expect(complete).toHaveBeenCalledOnce();
      expect(cancelPending).not.toHaveBeenCalled();
    } finally {
      provider.resolve(ERROR);
      await stopping;
    }
  });

  it.each([false, true])(
    "defers cancellation of a resolved pending begin until drain start (stop=%s)",
    async (stopBeforeStart) => {
      const entered = createDeferred();
      const release = createDeferred();
      const store = createMemoryStore();
      const originalBegin = store.begin;
      const begin = vi.spyOn(store, "begin").mockImplementation(async (input, assertCurrent) => {
        entered.resolve();
        await release.promise;
        return originalBegin(input, assertCurrent);
      });
      const complete = vi.spyOn(store, "complete");
      const execute = vi.fn<WorkerInferenceExecutor>(async () => DONE);
      const instance = makeManager(execute, store);
      const sink = createSink();
      const started = instance.start({
        sessionTarget: SESSION_TARGET,
        identity: IDENTITY,
        request: REQUEST,
        sink: sink.sink,
      });
      await entered.promise;
      const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      const stopping = stopBeforeStart ? instance.stop() : undefined;
      const settled = vi.fn();
      const joined = drain.drained.then(settled);
      try {
        release.resolve();
        const result = await started;
        if (!result.ok) {
          throw new Error(`pending admission failed: ${result.reason}`);
        }
        expect(complete).not.toHaveBeenCalled();
        result.launch();
        expect(sink.frames).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(drain.hasWork()).toBe(true);
        drain.start();
        drain.start();
        await joined;
        await stopping;
        expect(begin).toHaveBeenCalledOnce();
        expect(complete).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
        expect(terminalFrames(sink.frames)).toHaveLength(1);
        expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
          reason: "cancelled",
        });
        expect(drain.hasWork()).toBe(false);
      } finally {
        release.resolve();
        drain.start();
        await Promise.allSettled([started, joined, stopping, instance.stop()]);
        drain.release();
      }
    },
  );

  it("cancels an admitted start while its durable begin is pending", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const store = createMemoryStore();
    store.begin = async () => {
      entered.resolve();
      await release.promise;
      return { kind: "claimed" };
    };
    const complete = vi.spyOn(store, "complete");
    const execute = vi.fn<WorkerInferenceExecutor>(async () => DONE);
    const instance = makeManager(execute, store);
    const sink = createSink();
    const started = instance.start({
      sessionTarget: SESSION_TARGET,
      identity: IDENTITY,
      request: REQUEST,
      sink: sink.sink,
    });
    await entered.promise;
    const captured = instance.captureSessionCancellation(REQUEST.sessionId);
    expect(captured.runIds).toEqual([REQUEST.runId]);
    const onCancelled = vi.fn();
    const cancelled = captured.cancel({ onCancelled });
    expect(onCancelled).toHaveBeenCalledExactlyOnceWith(REQUEST.runId);
    expect(complete).not.toHaveBeenCalled();
    release.resolve();
    const result = await started;
    if (result.ok) {
      result.launch();
    }
    expect(await cancelled).toEqual([REQUEST.runId]);
    await instance.stop();
    expect(execute).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(terminalFrames(sink.frames)).toHaveLength(1);
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({ reason: "cancelled" });
  });
});
