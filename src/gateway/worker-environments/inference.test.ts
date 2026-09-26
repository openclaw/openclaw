import { describe, expect, it, vi } from "vitest";
import type { WorkerInferenceTerminalOutcome } from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { collectErrorGraphCandidates } from "../../infra/errors.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { parseApiErrorInfo } from "../../shared/assistant-error-format.js";
import { createWorkerInferenceManager, type WorkerInferenceExecutor } from "./inference.js";
import {
  accept,
  createMemoryStore,
  createSink,
  DONE,
  ERROR,
  IDENTITY,
  identityFor,
  makeManager,
  REQUEST,
  SESSION_TARGET,
  terminalFrames,
  waitForFast,
} from "./inference.test-support.js";

describe("worker inference manager", () => {
  it.each(["complete", "execute", "cancelPending"] as const)(
    "preserves independent authority and native failures through %s settlement",
    async (stage) => {
      const ordinary = new Error("source authority failed independently");
      const errorGraph = (error: unknown) =>
        collectErrorGraphCandidates(error, (current) => [
          ...(current instanceof Error ? [current.cause] : []),
          ...(current instanceof AggregateError ? current.errors : []),
        ]);
      const native = new SqliteWorkerError(
        "independent native settlement is unknown",
        "outcome-unknown",
      );
      const release = createDeferred<WorkerInferenceTerminalOutcome>();
      const operationEntered = createDeferred();
      const providerEntered = createDeferred<Parameters<WorkerInferenceExecutor>[0]>();
      let invalid = false;
      let refused: unknown;
      const observeGuard = (assertCurrent?: () => void) => {
        try {
          assertCurrent?.();
        } catch (error) {
          refused = error;
        }
      };
      const store = createMemoryStore();
      const begin = vi.spyOn(store, "begin");
      const complete = vi.spyOn(store, "complete");
      const cancelPending = vi.spyOn(store, "cancelPending");
      // Synthetic controls; the SQLite refusal/reply-loss proof lives in inference-store.test.ts.
      if (stage === "complete") {
        complete.mockImplementation(async (_input, assertCurrent) => {
          operationEntered.resolve();
          await release.promise;
          observeGuard(assertCurrent);
          throw native;
        });
      }
      if (stage === "cancelPending") {
        cancelPending.mockImplementation(async (_input, assertCurrent) => {
          operationEntered.resolve();
          await release.promise;
          observeGuard(assertCurrent);
          throw native;
        });
      }
      const execute = vi.fn<WorkerInferenceExecutor>((params) => {
        providerEntered.resolve(params);
        return stage === "execute" ? release.promise : Promise.resolve(DONE);
      });
      const instance = makeManager(execute, store);
      const sink = createSink();
      const revalidate = () => {
        if (invalid) {
          throw ordinary;
        }
        return null;
      };
      let cancellation: ReturnType<typeof instance.cancel> | undefined;
      let drain: ReturnType<ReturnType<typeof instance.reserveSessionDrain>["accept"]> | undefined;
      try {
        if (stage === "cancelPending") {
          cancellation = instance.cancel({ identity: IDENTITY, request: REQUEST, revalidate });
          await operationEntered.promise;
        } else {
          await accept(instance, { sink: sink.sink, revalidate });
          if (stage === "complete") {
            await operationEntered.promise;
          } else {
            await providerEntered.promise;
          }
        }
        const reserved = instance.reserveSessionDrain(REQUEST.sessionId).accept();
        drain = reserved;
        const drained = Promise.allSettled([drain.drained]);
        invalid = true;
        if (stage === "execute") {
          const provider = await providerEntered.promise;
          provider.emit({ type: "text_delta", contentIndex: 0, delta: "must not be sent" });
          expect(provider.signal.aborted).toBe(true);
          release.reject(native);
          await Promise.allSettled([release.promise]);
        } else {
          release.resolve(DONE);
          const completion =
            stage === "complete" ? complete.mock.results[0] : cancelPending.mock.results[0];
          if (completion?.type !== "return") {
            throw new Error("settlement operation was not entered");
          }
          await Promise.allSettled([completion.value]);
          if (stage === "complete") {
            expect(refused).toMatchObject({ cause: ordinary });
          } else {
            expect(refused).toBe(ordinary);
          }
        }
        if (cancellation) {
          expect(await cancellation).toEqual({ ok: false, reason: "provider-error" });
        }
        reserved.start();
        const [settled] = await drained;
        if (settled.status !== "rejected") {
          throw new Error("raw settlement discarded independent failures");
        }
        expect(hasSqliteWorkerOutcomeUnknown(settled.reason)).toBe(true);
        expect(errorGraph(settled.reason)).toContain(ordinary);
        expect(errorGraph(settled.reason)).toContain(native);
        expect(complete).toHaveBeenCalledTimes(stage === "complete" ? 1 : 0);
        expect(cancelPending).toHaveBeenCalledTimes(stage === "cancelPending" ? 1 : 0);
        expect(sink.frames).toEqual([]);
        drain.release();
        invalid = false;
        expect(
          await instance.start({
            identity: IDENTITY,
            request: REQUEST,
            sessionTarget: SESSION_TARGET,
            sink: sink.sink,
          }),
        ).toEqual({ ok: false, reason: "provider-error" });
        expect(begin).toHaveBeenCalledTimes(stage === "cancelPending" ? 0 : 1);
        const [stopped] = await Promise.allSettled([instance.stop()]);
        if (stopped.status !== "rejected") {
          throw new Error("shutdown discarded independent failures");
        }
        expect(hasSqliteWorkerOutcomeUnknown(stopped.reason)).toBe(true);
        expect(errorGraph(stopped.reason)).toContain(ordinary);
        expect(errorGraph(stopped.reason)).toContain(native);
      } finally {
        invalid = false;
        release.resolve(DONE);
        if (drain) {
          // Accepted reservations must start even when an earlier assertion fails.
          drain.start();
          await Promise.allSettled([cancellation, drain.drained, instance.stop()]);
          drain.release();
        } else {
          await Promise.allSettled([cancellation, instance.stop()]);
        }
      }
    },
  );

  it.each(["claimed", "replay"] as const)(
    "coalesces pending %s turns without publishing before each sink launches",
    async (kind) => {
      const begun = createDeferred();
      const allowBegin = createDeferred();
      const providerStarted = createDeferred();
      const finishProvider = createDeferred();
      const store = createMemoryStore();
      const begin = vi.spyOn(store, "begin").mockImplementation(async () => {
        begun.resolve();
        await allowBegin.promise;
        return kind === "replay" ? { kind, outcome: DONE } : { kind };
      });
      const execute = vi.fn<WorkerInferenceExecutor>(async ({ emit }) => {
        emit({ type: "text_delta", contentIndex: 0, delta: "first" });
        providerStarted.resolve();
        await finishProvider.promise;
        emit({ type: "text_delta", contentIndex: 0, delta: "second" });
        return DONE;
      });
      const instance = makeManager(execute, store);
      const first = createSink("first");
      const second = createSink("second");
      const pendingFirst = accept(instance, { sink: first.sink }, false);
      await begun.promise;
      const pendingSecond = accept(instance, { sink: second.sink }, false);
      allowBegin.resolve();
      const [acceptedFirst, acceptedSecond] = await Promise.all([pendingFirst, pendingSecond]);
      expect(begin).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(first.frames).toEqual([]);
      expect(second.frames).toEqual([]);

      acceptedFirst.launch();
      await Promise.resolve();
      expect(first.frames).toEqual([]);
      expect(second.frames).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      acceptedSecond.launch();
      if (kind === "claimed") {
        await providerStarted.promise;
        finishProvider.resolve();
        expect(execute).toHaveBeenCalledOnce();
        expect(second.frames[0]).toMatchObject({ payload: { event: { delta: "first" } } });
      } else {
        expect(execute).not.toHaveBeenCalled();
      }
      await second.terminal;
      expect(terminalFrames(first.frames)).toEqual([]);
      if (kind === "claimed") {
        expect(second.frames[1]).toMatchObject({ payload: { event: { delta: "second" } } });
      }
      await instance.stop();
    },
  );

  it.each(["ordinary", "outcome-unknown"] as const)(
    "retains %s stream revalidation failure without mutating an unknown outcome",
    async (failureKind) => {
      const failure =
        failureKind === "outcome-unknown"
          ? new Error("revalidation failed", {
              cause: new SqliteWorkerError("revalidation result lost", "outcome-unknown"),
            })
          : new Error("revalidation unavailable");
      const entered = createDeferred<Parameters<WorkerInferenceExecutor>[0]>();
      const finished = createDeferred<WorkerInferenceTerminalOutcome>();
      const store = createMemoryStore();
      const complete = vi.spyOn(store, "complete");
      const instance = makeManager(async (params) => {
        entered.resolve(params);
        return await finished.promise;
      }, store);
      let current = true;
      const sink = createSink();
      await accept(instance, {
        sink: sink.sink,
        revalidate: () => {
          if (!current) {
            throw failure;
          }
          return null;
        },
      });
      const provider = await entered.promise;
      const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      const rejected = expect(drain.drained).rejects.toBe(failure);
      current = false;
      provider.emit({ type: "text_delta", contentIndex: 0, delta: "must be fenced" });
      expect(provider.signal.aborted).toBe(true);
      drain.start();
      finished.resolve(DONE);
      await rejected;
      expect(complete).toHaveBeenCalledTimes(failureKind === "outcome-unknown" ? 0 : 1);
      expect(sink.frames.filter((frame) => frame.event === "worker.inference.event")).toEqual([]);
      drain.release();
      if (failureKind === "outcome-unknown") {
        expect(terminalFrames(sink.frames)).toEqual([]);
        await expect(instance.stop()).rejects.toBe(failure);
      } else {
        expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
          reason: "provider-error",
        });
        await instance.stop();
      }
    },
  );

  it.each(["ordinary", "outcome-unknown"] as const)(
    "rejects a non-admitted start with its original %s authority failure",
    async (failureKind) => {
      const failure =
        failureKind === "outcome-unknown"
          ? new Error("initial revalidation failed", {
              cause: new SqliteWorkerError("initial native result lost", "outcome-unknown"),
            })
          : new Error("initial revalidation unavailable");
      const store = createMemoryStore();
      const begin = vi.spyOn(store, "begin");
      const complete = vi.spyOn(store, "complete");
      const cancelPending = vi.spyOn(store, "cancelPending");
      const execute = vi.fn<WorkerInferenceExecutor>(async () => DONE);
      const instance = makeManager(execute, store);
      const sink = createSink();
      try {
        await expect(
          instance.start({
            identity: IDENTITY,
            request: REQUEST,
            sessionTarget: SESSION_TARGET,
            sink: sink.sink,
            revalidate: () => {
              throw failure;
            },
          }),
        ).rejects.toBe(failure);
        await expect(
          instance.start({
            identity: IDENTITY,
            request: REQUEST,
            sessionTarget: SESSION_TARGET,
            sink: sink.sink,
            assertSourceCurrent: () => {
              throw failure;
            },
          }),
        ).rejects.toBe(failure);
        expect(begin).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(sink.frames).toEqual([]);
        expect(instance.hasSession(REQUEST.sessionId)).toBe(false);
        await expect(
          instance.cancel({
            identity: IDENTITY,
            request: REQUEST,
            revalidate: () => {
              throw failure;
            },
          }),
        ).rejects.toBe(failure);
        expect(cancelPending).not.toHaveBeenCalled();
        expect(sink.frames).toEqual([]);
        const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
        drain.start();
        await expect(drain.drained).resolves.toBeUndefined();
        drain.release();
        await accept(instance, { sink: sink.sink });
        await waitForFast(() => expect(terminalFrames(sink.frames)).toHaveLength(1));
        expect(execute).toHaveBeenCalledOnce();
        await expect(instance.stop()).resolves.toBeUndefined();
      } finally {
        await instance.stop().catch(() => undefined);
      }
    },
  );

  it.each(["ordinary", "outcome-unknown"] as const)(
    "retains %s begin-guard revalidation without completing inference",
    async (failureKind) => {
      const failure =
        failureKind === "outcome-unknown"
          ? new Error("begin revalidation failed", {
              cause: new SqliteWorkerError("begin native result lost", "outcome-unknown"),
            })
          : new Error("begin revalidation unavailable");
      const entered = createDeferred();
      const release = createDeferred();
      const store = createMemoryStore();
      const begin = vi.spyOn(store, "begin").mockImplementation(async (_input, assertCurrent) => {
        entered.resolve();
        await release.promise;
        assertCurrent?.();
        return { kind: "claimed" };
      });
      const complete = vi.spyOn(store, "complete");
      const execute = vi.fn<WorkerInferenceExecutor>(async () => DONE);
      const instance = makeManager(execute, store);
      let invalid = false;
      const started = instance.start({
        identity: IDENTITY,
        request: REQUEST,
        sessionTarget: SESSION_TARGET,
        sink: createSink().sink,
        revalidate: () => {
          if (invalid) {
            throw failure;
          }
          return null;
        },
      });
      await entered.promise;
      invalid = true;
      release.resolve();
      expect(await started).toEqual({ ok: false, reason: "provider-error" });
      const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      drain.start();
      await expect(drain.drained).rejects.toBe(failure);
      drain.release();
      await expect(instance.stop()).rejects.toBe(failure);
      expect(begin).toHaveBeenCalledOnce();
      expect(complete).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("awaits pending recovery before admitting a turn", async () => {
    const recovery = createDeferred();
    const store = createMemoryStore();
    vi.spyOn(store, "recoverPending").mockReturnValue(recovery.promise);
    const begin = vi.spyOn(store, "begin");
    const execute = vi.fn<WorkerInferenceExecutor>(async () => DONE);
    const instance = makeManager(execute, store);
    let ready = false;
    const readiness = instance.ready().then(() => {
      ready = true;
    });
    const started = accept(instance, {}, false);
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(begin).not.toHaveBeenCalled();
    recovery.resolve();
    await readiness;
    expect((await started).result.status).toBe("accepted");
    expect(begin).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    await instance.stop();
  });

  it("persists and replays a bounded executor failure without repeating inference", async () => {
    const execute = vi.fn<WorkerInferenceExecutor>(async () => {
      throw Object.assign(new Error("Upstream unavailable"), { status: 503, code: "server_error" });
    });
    let stored: WorkerInferenceTerminalOutcome | undefined;
    const store = createMemoryStore();
    store.begin = async () => (stored ? { kind: "replay", outcome: stored } : { kind: "claimed" });
    store.complete = async (input) => (stored = input.outcome);
    const instance = makeManager(execute, store);
    const sink = createSink();
    await accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(terminalFrames(sink.frames)).toHaveLength(1));
    const outcome = terminalFrames(sink.frames)[0]?.payload.outcome;
    if (outcome?.type !== "error") {
      throw new Error("expected failed inference terminal");
    }
    expect(parseApiErrorInfo(outcome.message)).toMatchObject({
      httpCode: "503",
      code: "server_error",
      message: "Upstream unavailable",
    });
    const replay = createSink("replay");
    expect((await accept(instance, { sink: replay.sink })).result.status).toBe("replayed");
    expect(terminalFrames(replay.frames)[0]?.payload.outcome).toEqual(outcome);
    expect(execute).toHaveBeenCalledOnce();
    await instance.stop();
  });

  it("rejects oversized and concurrent turns", async () => {
    const store = createMemoryStore();
    const execute = vi.fn<WorkerInferenceExecutor>(async () => ERROR);
    const limited = createWorkerInferenceManager({ execute, store, requestMaxBytes: 32 });
    expect(
      await limited.start({
        sessionTarget: SESSION_TARGET,
        identity: IDENTITY,
        request: REQUEST,
        sink: createSink().sink,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid-context",
    });
    await limited.stop();
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const instance = makeManager(({ signal }) => {
      signal.addEventListener("abort", () => pending.resolve(ERROR), { once: true });
      return pending.promise;
    });
    const sink = createSink();
    await accept(instance, { sink: sink.sink });
    const competing = { ...REQUEST, runId: "run-b", turnId: "turn-b" };
    expect(
      await instance.start({
        sessionTarget: SESSION_TARGET,
        identity: identityFor(competing),
        request: competing,
        sink: createSink().sink,
      }),
    ).toEqual({ ok: false, reason: "invalid-context" });
    await instance.stop();
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
      reason: "provider-error",
    });
  });

  it("settles cumulatively oversized output while preserving the abort reason", async () => {
    let signal: AbortSignal | undefined;
    const store = createMemoryStore();
    vi.spyOn(store, "begin")
      .mockResolvedValueOnce({ kind: "claimed" })
      .mockResolvedValueOnce({ kind: "claimed" })
      .mockResolvedValueOnce({ kind: "replay", outcome: ERROR });
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const instance = createWorkerInferenceManager({
      execute: ({ emit, signal: nextSignal }) => {
        signal = nextSignal;
        const delta = "x".repeat(512);
        for (let index = 0; index < 5; index += 1) {
          emit({ type: "text_delta", contentIndex: 0, delta });
        }
        return pending.promise;
      },
      store,
      streamMaxBytes: 2_048,
    });
    const sink = createSink();
    await accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(signal?.aborted).toBe(true));
    await waitForFast(() =>
      expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
        reason: "provider-error",
      }),
    );
    const retryRequest = { ...REQUEST, runId: "retry-run", turnId: "retry-turn" };
    const retry = createSink("retry");
    await accept(instance, {
      identity: identityFor(retryRequest),
      request: retryRequest,
      sink: retry.sink,
    });
    await retry.terminal;
    const replay = createSink("replay");
    expect((await accept(instance, { sink: replay.sink })).result.status).toBe("replayed");
    expect(terminalFrames(replay.frames)[0]?.payload.outcome).toEqual(ERROR);
    pending.resolve(ERROR);
    await instance.stop();
  });

  it.each(["recover", "replay", "outcome-unknown"] as const)(
    "reconciles an explicitly retried failed terminal through %s",
    async (kind) => {
      const failure =
        kind === "outcome-unknown"
          ? new Error("terminal result lost", {
              cause: new SqliteWorkerError(
                "native terminal outcome unavailable",
                "outcome-unknown",
              ),
            })
          : new Error("write failed");
      const store = createMemoryStore();
      const begin = vi
        .spyOn(store, "begin")
        .mockResolvedValueOnce({ kind: "claimed" })
        .mockResolvedValue(
          kind === "replay" ? { kind: "replay", outcome: DONE } : { kind: "recover" },
        );
      const complete = vi.spyOn(store, "complete").mockRejectedValueOnce(failure);
      const entered = createDeferred();
      const provider = createDeferred<WorkerInferenceTerminalOutcome>();
      const execute = vi.fn<WorkerInferenceExecutor>(async () => {
        entered.resolve();
        return await provider.promise;
      });
      const instance = makeManager(execute, store);
      const original = createSink("original");
      await accept(instance, { sink: original.sink });
      await entered.promise;
      const drain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
      drain.start();
      const failed = expect(drain.drained).rejects.toBe(failure);
      provider.resolve(ERROR);
      await failed;
      drain.release();
      expect(terminalFrames(original.frames)).toEqual([]);
      const retry = createSink("retry");
      const retried = await instance.start({
        identity: IDENTITY,
        request: REQUEST,
        sessionTarget: SESSION_TARGET,
        sink: retry.sink,
      });
      if (kind === "outcome-unknown") {
        expect(retried).toEqual({ ok: false, reason: "provider-error" });
        expect(begin).toHaveBeenCalledOnce();
        expect(complete).toHaveBeenCalledOnce();
        expect(retry.frames).toEqual([]);
        begin.mockResolvedValueOnce({ kind: "claimed" });
        const successorRequest = {
          ...REQUEST,
          runId: "independent-successor",
          turnId: "independent-turn",
        };
        await accept(
          instance,
          {
            identity: identityFor(successorRequest),
            request: successorRequest,
          },
          false,
        );
        const successorDrain = instance.reserveSessionDrain(REQUEST.sessionId).accept();
        successorDrain.start();
        await expect(successorDrain.drained).resolves.toBeUndefined();
        successorDrain.release();
        expect(begin).toHaveBeenCalledTimes(2);
        expect(complete).toHaveBeenCalledTimes(2);
        expect(
          await instance.start({
            identity: IDENTITY,
            request: REQUEST,
            sessionTarget: SESSION_TARGET,
            sink: retry.sink,
          }),
        ).toEqual({ ok: false, reason: "provider-error" });
        expect(begin).toHaveBeenCalledTimes(2);
        expect(complete).toHaveBeenCalledTimes(2);
        await expect(instance.stop()).rejects.toBe(failure);
      } else {
        if (!retried.ok) {
          throw new Error(`explicit retry failed: ${retried.reason}`);
        }
        expect(retried.result.status).toBe("replayed");
        expect(retry.frames).toEqual([]);
        retried.launch();
        expect(terminalFrames(retry.frames)).toHaveLength(1);
        expect(terminalFrames(retry.frames)[0]?.payload.outcome).toEqual(
          kind === "replay" ? DONE : ERROR,
        );
        expect(begin).toHaveBeenCalledTimes(2);
        expect(complete).toHaveBeenCalledTimes(kind === "recover" ? 2 : 1);
        await instance.stop();
      }
      expect(execute).toHaveBeenCalledOnce();
    },
  );

  it("rebinds an active stream on reconnect without a second provider call", async () => {
    const release = createDeferred();
    const execute = vi.fn<WorkerInferenceExecutor>(async ({ emit }) => {
      emit({ type: "text_delta", contentIndex: 0, delta: "first" });
      await release.promise;
      emit({ type: "text_delta", contentIndex: 0, delta: "second" });
      return ERROR;
    });
    const instance = makeManager(execute);
    const first = createSink("first");
    await accept(instance, { sink: first.sink });
    await waitForFast(() => expect(first.frames).toHaveLength(1));

    const second = createSink("second");
    expect((await accept(instance, { sink: second.sink })).result.status).toBe("accepted");
    release.resolve();

    await waitForFast(() => expect(terminalFrames(second.frames)).toHaveLength(1));
    expect(execute).toHaveBeenCalledOnce();
    expect(terminalFrames(first.frames)).toEqual([]);
    expect(second.frames[0]).toMatchObject({
      event: "worker.inference.event",
      payload: { seq: 2, event: { type: "text_delta", delta: "second" } },
    });
    await instance.stop();
  });

  it("fences an epoch flip between acceptance and the terminal outcome", async () => {
    let current = true;
    let signal: AbortSignal | undefined;
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const execute = vi.fn<WorkerInferenceExecutor>(({ signal: nextSignal }) => {
      signal = nextSignal;
      return pending.promise;
    });
    const instance = makeManager(execute);
    const sink = createSink("epoch-flip");
    const accepted = await accept(
      instance,
      { sink: sink.sink, revalidate: () => (current ? null : "epoch-mismatch") },
      false,
    );
    accepted.launch();
    await waitForFast(() => expect(execute).toHaveBeenCalledOnce());

    current = false;
    pending.resolve(DONE);

    await waitForFast(() => expect(terminalFrames(sink.frames)).toHaveLength(1));
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
      reason: "epoch-mismatch",
    });
    expect(signal?.aborted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    await instance.stop();
  });

  it("fences wrong session, epoch, and revalidation failures", async () => {
    const execute = vi.fn<WorkerInferenceExecutor>(async () => ERROR);
    const instance = makeManager(execute);
    for (const [identity, reason] of [
      [{ ...IDENTITY, sessionId: "other" }, "session-not-attached"],
      [{ ...IDENTITY, ownerEpoch: REQUEST.runEpoch + 1 }, "epoch-mismatch"],
    ] as const) {
      expect(
        await instance.start({
          sessionTarget: SESSION_TARGET,
          identity,
          request: REQUEST,
          sink: createSink().sink,
        }),
      ).toEqual({
        ok: false,
        reason,
      });
    }
    expect(execute).not.toHaveBeenCalled();

    await instance.stop();
    let current = true;
    const sink = createSink("broken-fence");
    const broken = makeManager(async () => ERROR);
    const accepted = await accept(
      broken,
      {
        sink: sink.sink,
        revalidate: () => {
          if (current) {
            return null;
          }
          throw new Error("revalidation failed");
        },
      },
      false,
    );
    current = false;
    accepted.launch();
    await waitForFast(() => expect(terminalFrames(sink.frames)).toHaveLength(1));
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
      reason: "provider-error",
    });
    await broken.stop();
  });
});
