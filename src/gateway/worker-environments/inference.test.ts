import { describe, expect, it, vi } from "vitest";
import type {
  WorkerInferenceStartParams,
  WorkerInferenceTerminalFrame,
  WorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { parseApiErrorInfo } from "../../shared/assistant-error-format.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleChatAbortRequestWithLifecycle } from "../server-methods/chat-abort-handler.js";
import {
  createActiveRun,
  createChatAbortContext,
  invokeChatAbortHandler,
} from "../server-methods/chat.abort.test-helpers.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { registerWorkerInferenceSessionControl } from "./inference-control-internal.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import {
  createWorkerInferenceManager,
  type WorkerInferenceExecutor,
  type WorkerInferenceSink,
} from "./inference.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

const REQUEST: WorkerInferenceStartParams = {
  runEpoch: 3,
  sessionId: "s",
  runId: "r",
  turnId: "t",
  modelRef: { provider: "p", model: "m" },
  context: { messages: [] },
  options: {},
};
const SESSION_TARGET = {
  agentId: "main",
  sessionId: REQUEST.sessionId,
  sessionKey: "agent:main:inference",
  storePath: "inference-sessions.sqlite",
};
const IDENTITY: WorkerConnectionIdentity = {
  environmentId: "w",
  credentialHash: "d",
  bundleHash: "b",
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  turnClaim: {
    sessionId: REQUEST.sessionId,
    claimId: "claim-r",
    runId: REQUEST.runId,
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "w", ownerEpoch: REQUEST.runEpoch },
  },
  ownerEpoch: REQUEST.runEpoch,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-inference-v1"],
  credentialExpiresAtMs: 10_000,
};
const ERROR: WorkerInferenceTerminalOutcome = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
};
const DONE: WorkerInferenceTerminalOutcome = {
  type: "done",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: REQUEST.modelRef.provider,
    model: REQUEST.modelRef.model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  },
};
const CANCEL = {
  runEpoch: REQUEST.runEpoch,
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  turnId: REQUEST.turnId,
};

function identityFor(request: WorkerInferenceStartParams): WorkerConnectionIdentity {
  return {
    ...IDENTITY,
    sessionId: request.sessionId,
    runId: request.runId,
    turnClaim: {
      ...IDENTITY.turnClaim!,
      sessionId: request.sessionId,
      runId: request.runId,
      claimId: `claim-${request.runId}`,
    },
  };
}

type Manager = ReturnType<typeof createWorkerInferenceManager>;
type StartOverrides = {
  identity?: WorkerConnectionIdentity;
  request?: WorkerInferenceStartParams;
  sink?: WorkerInferenceSink;
  revalidate?: () => "epoch-mismatch" | null;
};

function createMemoryStore(): WorkerInferenceStore {
  return {
    begin: () => ({ kind: "claimed" }),
    complete: (input) => input.outcome,
    cancelPending() {},
    recoverPending() {},
  };
}

function createSink(connectionId = "c") {
  const frames: Parameters<WorkerInferenceSink["send"]>[0][] = [];
  const sink: WorkerInferenceSink = { connectionId, send: (frame) => frames.push(frame) };
  return { frames, sink };
}

function terminalFrames(frames: Parameters<WorkerInferenceSink["send"]>[0][]) {
  return frames.filter(
    (frame): frame is WorkerInferenceTerminalFrame => frame.event === "worker.inference.terminal",
  );
}

function accept(manager: Manager, overrides: StartOverrides = {}, launch = true) {
  const result = manager.start({
    sessionTarget: SESSION_TARGET,
    identity: IDENTITY,
    request: REQUEST,
    sink: createSink().sink,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`start failed: ${result.reason}`);
  }
  if (launch) {
    result.launch();
  }
  return result;
}

function makeManager(execute: WorkerInferenceExecutor, store = createMemoryStore()) {
  return createWorkerInferenceManager({ execute, store });
}

describe("worker inference manager", () => {
  it.each(["session", "environment"] as const)(
    "%s cancellation does not adopt a successor admitted by terminal delivery",
    async (kind) => {
      const instance = makeManager(async () => DONE);
      const frames: WorkerInferenceTerminalFrame[] = [];
      const replacementRequest = { ...REQUEST, turnId: "successor-turn" };
      const successor = createSink("successor");
      accept(
        instance,
        {
          sink: {
            connectionId: "original",
            send: (frame) => {
              if (frame.event !== "worker.inference.terminal") {
                return;
              }
              frames.push(frame);
              accept(instance, { request: replacementRequest, sink: successor.sink }, false);
            },
          },
        },
        false,
      );
      try {
        if (kind === "session") {
          expect(instance.cancelSession(REQUEST.sessionId)).toEqual([REQUEST.runId]);
        } else {
          instance.cancelEnvironment(IDENTITY.environmentId);
        }
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
    const instance = makeManager(async () => DONE);
    const successor = createSink("successor");
    let current = true;
    accept(
      instance,
      {
        sink: {
          connectionId: "original",
          send: (frame) => {
            if (frame.event !== "worker.inference.terminal") {
              return;
            }
            current = false;
            accept(
              instance,
              {
                request: { ...REQUEST, turnId: "successor-turn" },
                sink: successor.sink,
              },
              false,
            );
          },
        },
      },
      false,
    );
    const captured = instance.captureSessionCancellation(REQUEST.sessionId);
    const committed: string[] = [];
    try {
      expect(
        captured.cancel({
          assertCurrent: () => {
            if (!current) {
              throw new Error("source revoked");
            }
          },
          onCancelled: (runId) => committed.push(runId),
        }),
      ).toEqual([REQUEST.runId]);
      expect(committed).toEqual([REQUEST.runId]);
      expect(terminalFrames(successor.frames)).toEqual([]);
      expect(captured.cancel()).toEqual([]);
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
            beginDrain: instance.beginSessionDrain,
            captureCancel: instance.captureSessionCancellation,
            resolveTarget: instance.resolveSessionTargetForRunId,
          });
          const original = createSink();
          const successor = createSink("successor");
          accept(instance, { sink: original.sink });
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
                instance.cancelSession(REQUEST.sessionId, REQUEST.runId);
                accept(
                  instance,
                  {
                    request: { ...REQUEST, turnId: "successor-turn" },
                    sink: successor.sink,
                  },
                  false,
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

  it("persists and replays a bounded executor failure without repeating inference", async () => {
    const execute = vi.fn<WorkerInferenceExecutor>(async () => {
      throw Object.assign(new Error("Upstream unavailable"), { status: 503, code: "server_error" });
    });
    let stored: WorkerInferenceTerminalOutcome | undefined;
    const store = createMemoryStore();
    store.begin = () => (stored ? { kind: "replay", outcome: stored } : { kind: "claimed" });
    store.complete = (input) => (stored = input.outcome);
    const instance = makeManager(execute, store);
    const sink = createSink();
    accept(instance, { sink: sink.sink });
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
    expect(accept(instance, { sink: replay.sink }).result.status).toBe("replayed");
    expect(terminalFrames(replay.frames)[0]?.payload.outcome).toEqual(outcome);
    expect(execute).toHaveBeenCalledOnce();
    await instance.stop();
  });

  it("rejects oversized and concurrent turns", async () => {
    const store = createMemoryStore();
    const execute = vi.fn<WorkerInferenceExecutor>(async () => ERROR);
    const limited = createWorkerInferenceManager({ execute, store, requestMaxBytes: 32 });
    expect(
      limited.start({
        sessionTarget: SESSION_TARGET,
        identity: IDENTITY,
        request: REQUEST,
        sink: createSink().sink,
      }),
    ).toEqual({
      ok: false,
      reason: "invalid-context",
    });
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const instance = makeManager(({ signal }) => {
      signal.addEventListener("abort", () => pending.resolve(ERROR), { once: true });
      return pending.promise;
    });
    const sink = createSink();
    accept(instance, { sink: sink.sink });
    const competing = { ...REQUEST, runId: "run-b", turnId: "turn-b" };
    expect(
      instance.start({
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
    accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(signals).toHaveLength(1));
    for (let index = 0; index < 2; index += 1) {
      expect(instance.cancel({ identity: IDENTITY, request: CANCEL })).toEqual({
        ok: true,
        result: { status: "cancelled" },
      });
    }
    expect(signals[0]?.aborted).toBe(true);
    const nextRequest = { ...REQUEST, runId: "new-run", turnId: "new-turn" };
    accept(instance, { identity: identityFor(nextRequest), request: nextRequest });
    await waitForFast(() => expect(signals).toHaveLength(2));
    expect(instance.cancelSession(REQUEST.sessionId, "new-run")).toEqual(["new-run"]);
    expect(signals[1]?.aborted).toBe(true);
    await instance.stop();
  });

  it("blocks replacement inference until an exact session drain settles", async () => {
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const execute = vi.fn<WorkerInferenceExecutor>(async () => await pending.promise);
    const instance = makeManager(execute);
    accept(instance);
    await waitForFast(() => expect(execute).toHaveBeenCalledOnce());

    const drain = instance.beginSessionDrain(REQUEST.sessionId);
    expect(drain.hasWork()).toBe(true);
    const replacementRequest = { ...REQUEST, runId: "replacement", turnId: "replacement" };
    const replacementIdentity = identityFor(replacementRequest);
    expect(
      instance.start({
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
      instance.start({
        sessionTarget: SESSION_TARGET,
        identity: replacementIdentity,
        request: replacementRequest,
        sink: createSink().sink,
      }),
    ).toMatchObject({ ok: true });
    await instance.stop();
  });

  it("rejects an inference drain when terminal persistence fails", async () => {
    const store = createMemoryStore();
    vi.spyOn(store, "complete").mockImplementation(() => {
      throw new Error("write failed");
    });
    const pending = createDeferred<WorkerInferenceTerminalOutcome>();
    const instance = makeManager(async () => await pending.promise, store);
    accept(instance);

    const drain = instance.beginSessionDrain(REQUEST.sessionId);
    pending.resolve(ERROR);
    await expect(drain.drained).rejects.toThrow("terminal persistence failed");
    drain.release();
    await instance.stop();
  });

  it("settles cumulatively oversized output while preserving the abort reason", async () => {
    let signal: AbortSignal | undefined;
    const store = createMemoryStore();
    vi.spyOn(store, "begin")
      .mockReturnValueOnce({ kind: "claimed" })
      .mockReturnValueOnce({ kind: "claimed" })
      .mockReturnValueOnce({ kind: "replay", outcome: ERROR });
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
    accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(signal?.aborted).toBe(true));
    await waitForFast(() =>
      expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
        reason: "provider-error",
      }),
    );
    const retryRequest = { ...REQUEST, runId: "retry-run", turnId: "retry-turn" };
    accept(instance, { identity: identityFor(retryRequest), request: retryRequest });
    const replay = createSink("replay");
    expect(accept(instance, { sink: replay.sink }).result.status).toBe("replayed");
    expect(terminalFrames(replay.frames)[0]?.payload.outcome).toEqual(ERROR);
    pending.resolve(ERROR);
    await instance.stop();
  });

  it("does not send an unpersisted terminal", async () => {
    const store = createMemoryStore();
    vi.spyOn(store, "complete").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    const sink = createSink();
    const instance = makeManager(async () => ERROR, store);
    accept(instance, { sink: sink.sink });
    await waitForFast(() => expect(store.complete).toHaveBeenCalledOnce());
    expect(terminalFrames(sink.frames)).toEqual([]);
    await instance.stop();
  });

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
    accept(instance, { sink: first.sink });
    await waitForFast(() => expect(first.frames).toHaveLength(1));

    const second = createSink("second");
    expect(accept(instance, { sink: second.sink }).result.status).toBe("accepted");
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
    const accepted = accept(
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
        instance.start({
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

    let firstCheck = true;
    const sink = createSink("broken-fence");
    const broken = makeManager(async () => ERROR);
    accept(broken, {
      sink: sink.sink,
      revalidate: () => {
        if (firstCheck) {
          firstCheck = false;
          return null;
        }
        throw new Error("revalidation failed");
      },
    });
    await waitForFast(() => expect(terminalFrames(sink.frames)).toHaveLength(1));
    expect(terminalFrames(sink.frames)[0]?.payload.outcome).toMatchObject({
      reason: "provider-error",
    });
    await broken.stop();
  });
});
