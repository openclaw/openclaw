import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WorkerInferenceStartParams,
  type WorkerInferenceTerminalOutcome,
  validateWorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { collectErrorGraphCandidates } from "../../infra/errors.js";
import * as brokerReply from "../../infra/sqlite-worker-broker-reply.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { AcceptedWorkerInferenceSessionDrain } from "./inference-control-internal.js";
import {
  createWorkerInferenceStore,
  type WorkerInferenceStore,
  type WorkerInferenceTurnInput,
} from "./inference-store.js";
import { createWorkerInferenceStoreKernel } from "./inference-store.kernel.js";
import {
  createWorkerInferenceManager,
  type WorkerInferenceExecutor,
  type WorkerInferenceSink,
} from "./inference.js";
import { serializeWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerEnvironmentStore } from "./store.js";

const ENVIRONMENT_ID = "environment-inference-store";
const REQUEST: WorkerInferenceStartParams = {
  runEpoch: 3,
  sessionId: "session-inference-store",
  runId: "run-inference-store",
  turnId: "turn-inference-store",
  modelRef: { provider: "fixture-provider", model: "fixture-model" },
  context: { messages: [] },
  options: {},
};
const IDENTITY: WorkerConnectionIdentity = {
  environmentId: ENVIRONMENT_ID,
  credentialHash: ["fixture", "digest"].join("-"),
  bundleHash: ["fixture", "bundle", "digest"].join("-"),
  sessionId: REQUEST.sessionId,
  runId: REQUEST.runId,
  turnClaim: {
    sessionId: REQUEST.sessionId,
    claimId: "claim-store",
    runId: REQUEST.runId,
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: REQUEST.runEpoch },
  },
  ownerEpoch: REQUEST.runEpoch,
  rpcSetVersion: 1,
  protocolFeatures: ["worker-inference-v1"],
  credentialExpiresAtMs: 10_000,
};
const PROVIDER_ERROR: WorkerInferenceTerminalOutcome = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
};

function hashRequest(
  identity: WorkerConnectionIdentity,
  request: WorkerInferenceStartParams,
): string {
  if (!identity.turnClaim) {
    throw new Error("inference fixture requires a turn claim");
  }
  return createHash("sha256")
    .update(`${serializeWorkerSessionTurnClaim(identity.turnClaim)}\0${stableStringify(request)}`)
    .digest("hex");
}

const BASE_INPUT: WorkerInferenceTurnInput = {
  environmentId: ENVIRONMENT_ID,
  sessionId: REQUEST.sessionId,
  runEpoch: REQUEST.runEpoch,
  runId: REQUEST.runId,
  turnId: REQUEST.turnId,
  requestHash: hashRequest(IDENTITY, REQUEST),
};

function createSink() {
  const frames: Parameters<WorkerInferenceSink["send"]>[0][] = [];
  const terminal = createDeferred<WorkerInferenceTerminalOutcome>();
  const sink: WorkerInferenceSink = {
    connectionId: "connection-inference-store",
    send: (frame) => {
      frames.push(frame);
      if (frame.event === "worker.inference.terminal") {
        terminal.resolve(frame.payload.outcome);
      }
    },
  };
  return { frames, sink, terminal: terminal.promise };
}

describe("worker inference SQLite store", async () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let nowMs: number;
  let store: WorkerInferenceStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-inference-store-"));
    nowMs = 1_000;
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    await initializeStore();
  });

  async function initializeStore(): Promise<void> {
    const environments = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    await environments.createIntent({
      environmentId: ENVIRONMENT_ID,
      providerId: "fixture-provider",
      profileId: "fixture-profile",
      profileSnapshot: { settings: {}, lifetime: { idleMinutes: 10 } },
      provisionOperationId: "fixture-operation",
    });
    store = createWorkerInferenceStore({ path: database.path, now: () => nowMs });
  }

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function reopenStore(): Promise<WorkerInferenceStore> {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    return createWorkerInferenceStore({ path: database.path, now: () => nowMs });
  }

  function terminalRunIds(): string[] {
    const rows = database.db
      .prepare("SELECT run_id FROM worker_inference_turns WHERE state = 'terminal' ORDER BY run_id")
      .all() as Array<{ run_id: string }>;
    return rows.map((row) => row.run_id);
  }

  async function completeTurn(
    runId: string,
    outcome: WorkerInferenceTerminalOutcome = PROVIDER_ERROR,
  ): Promise<WorkerInferenceTurnInput> {
    const input = {
      ...BASE_INPUT,
      runId,
      turnId: `turn-${runId}`,
    };
    expect(await store.begin(input)).toEqual({ kind: "claimed" });
    expect(await store.complete({ ...input, outcome })).toEqual(outcome);
    return input;
  }

  async function expectReplayWithoutExecution(managerStore: WorkerInferenceStore) {
    const execute = vi.fn<WorkerInferenceExecutor>(async () => PROVIDER_ERROR);
    const manager = createWorkerInferenceManager({
      execute,
      store: managerStore,
    });
    const { frames, sink } = createSink();
    const result = await manager.start({
      identity: IDENTITY,
      sessionTarget: {
        agentId: "main",
        sessionId: REQUEST.sessionId,
        sessionKey: "agent:main:inference-store",
        storePath: path.join(root, "sessions.sqlite"),
      },
      request: REQUEST,
      sink,
    });
    if (!result.ok) {
      throw new Error(`start failed: ${result.reason}`);
    }
    expect(result.result).toEqual({ status: "replayed" });
    result.launch();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      event: "worker.inference.terminal",
      payload: { outcome: PROVIDER_ERROR },
    });
    expect(execute).not.toHaveBeenCalled();
    return manager;
  }

  it("rejects a terminal identity with a different request hash as a conflict", async () => {
    expect(await store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    await store.complete({ ...BASE_INPUT, outcome: PROVIDER_ERROR });

    expect(await store.begin({ ...BASE_INPUT, requestHash: "b".repeat(64) })).toEqual({
      kind: "rejected",
      reason: "conflict",
    });
  });

  it("replays a cached terminal outcome without executing the provider again", async () => {
    expect(await store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    await store.complete({ ...BASE_INPUT, outcome: PROVIDER_ERROR });

    const manager = await expectReplayWithoutExecution(await reopenStore());
    await manager.stop();
  });

  it("recovers a crashed pending turn as provider-error without executing the provider", async () => {
    expect(await store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });
    const reopened = await reopenStore();
    expect(await reopened.begin(BASE_INPUT)).toEqual({ kind: "recover" });

    const manager = await expectReplayWithoutExecution(reopened);
    await manager.stop();
  });

  it.each(["known-refusal", "lost-refusal-reply"] as const)(
    "preserves native begin settlement after an ordinary authority failure (%s)",
    async (mode) => {
      const ordinary = new Error("inference authority was revoked after native dispatch");
      const errorGraph = (error: unknown) =>
        collectErrorGraphCandidates(error, (current) => [
          ...(current instanceof Error ? [current.cause] : []),
          ...(current instanceof AggregateError ? current.errors : []),
        ]);
      const dispatched = createDeferred();
      const submitted = createDeferred<{ promise: ReturnType<WorkerInferenceStore["begin"]> }>();
      const originalBegin = store.begin;
      const begin = vi.spyOn(store, "begin").mockImplementation((...args) => {
        const promise = originalBegin(...args);
        submitted.resolve({ promise });
        return promise;
      });
      const complete = vi.spyOn(store, "complete");
      const execute = vi.fn<WorkerInferenceExecutor>(async () => PROVIDER_ERROR);
      const manager = createWorkerInferenceManager({ execute, store });
      const initial = createSink();
      const sessionTarget = {
        agentId: "main",
        sessionId: REQUEST.sessionId,
        sessionKey: "agent:main:inference-store",
        storePath: path.join(root, "sessions.sqlite"),
      };
      let invalid = false;
      let target: { worker: Worker; id: number; actor: number } | undefined;
      let refusalReplies = 0;
      let drain: AcceptedWorkerInferenceSessionDrain | undefined;
      const restores: Array<() => void> = [];
      try {
        await manager.ready();
        const originalPost: unknown = Object.getOwnPropertyDescriptor(
          Worker.prototype,
          "postMessage",
        )?.value;
        if (typeof originalPost !== "function") {
          throw new Error("native Worker.postMessage is not an own callable property");
        }
        const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
          this: Worker,
          ...args: Parameters<Worker["postMessage"]>
        ) {
          const request: unknown = args[0];
          if (
            !target &&
            isRecord(request) &&
            request.type === "execute" &&
            request.input instanceof Uint8Array
          ) {
            const command: unknown = deserialize(request.input);
            if (isRecord(command) && command.type === "workerInference.begin") {
              if (
                typeof request.id !== "number" ||
                typeof request.actor !== "number" ||
                !(request.operationAdmission instanceof MessagePort)
              ) {
                throw new Error("native begin omitted its operation admission");
              }
              Reflect.apply(originalPost, this, args);
              target = { worker: this, id: request.id, actor: request.actor };
              invalid = true;
              dispatched.resolve();
              return;
            }
          }
          Reflect.apply(originalPost, this, args);
        });
        restores.push(() => posts.mockRestore());
        const originalReceive = brokerReply.receiveSqliteWorkerReply;
        const replies = vi
          .spyOn(brokerReply, "receiveSqliteWorkerReply")
          .mockImplementation((slot, reply, owner) => {
            const job = slot.current;
            const refusal = job?.operationAdmission?.admission.failure;
            if (
              target &&
              slot.worker === target.worker &&
              job?.request.id === target.id &&
              job.request.actor === target.actor &&
              reply.id === target.id &&
              !reply.ok &&
              job.nativeDispatched &&
              refusal instanceof Error &&
              refusal.cause === ordinary
            ) {
              refusalReplies += 1;
              if (mode === "lost-refusal-reply" && refusalReplies === 1) {
                return originalReceive(slot, { ...reply, id: reply.id + 1 }, owner);
              }
            }
            return originalReceive(slot, reply, owner);
          });
        restores.push(() => replies.mockRestore());
        const started = manager.start({
          identity: IDENTITY,
          request: REQUEST,
          sessionTarget,
          sink: initial.sink,
          revalidate: () => {
            if (invalid) {
              throw ordinary;
            }
            return null;
          },
        });
        const { promise } = await submitted.promise;
        const endedBeforeDispatch = promise.then(
          () => {
            throw new Error("begin settled without observed native dispatch");
          },
          () => {
            throw new Error("begin failed before observed native dispatch");
          },
        );
        await Promise.race([dispatched.promise, endedBeforeDispatch]);
        drain = manager.reserveSessionDrain(REQUEST.sessionId).accept();
        const drained = Promise.allSettled([drain.drained]);
        const [native] = await Promise.allSettled([promise]);
        if (native.status !== "rejected") {
          throw new Error("native begin unexpectedly succeeded");
        }
        expect(refusalReplies).toBe(1);
        expect(hasSqliteWorkerOutcomeUnknown(native.reason)).toBe(mode === "lost-refusal-reply");
        expect(await started).toEqual({ ok: false, reason: "provider-error" });
        drain.start();
        const [settled] = await drained;
        if (settled.status !== "rejected") {
          throw new Error("accepted drain discarded begin failure");
        }
        expect(hasSqliteWorkerOutcomeUnknown(settled.reason)).toBe(mode === "lost-refusal-reply");
        expect(complete).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(initial.frames).toEqual([]);
        expect(database.db.prepare("SELECT turn_id FROM worker_inference_turns").all()).toEqual([]);
        drain.release();
        invalid = false;
        if (mode === "lost-refusal-reply") {
          expect(errorGraph(settled.reason)).toContain(ordinary);
          expect(errorGraph(settled.reason)).toContain(native.reason);
          expect(
            await manager.start({
              identity: IDENTITY,
              request: REQUEST,
              sessionTarget,
              sink: initial.sink,
            }),
          ).toEqual({ ok: false, reason: "provider-error" });
          expect(begin).toHaveBeenCalledOnce();
          expect(complete).not.toHaveBeenCalled();
          const [stopped] = await Promise.allSettled([manager.stop()]);
          if (stopped.status !== "rejected") {
            throw new Error("shutdown discarded native refusal evidence");
          }
          expect(hasSqliteWorkerOutcomeUnknown(stopped.reason)).toBe(true);
          expect(errorGraph(stopped.reason)).toContain(ordinary);
          expect(errorGraph(stopped.reason)).toContain(native.reason);
        } else {
          expect(settled.reason).toBe(ordinary);
          expect(native.reason).toMatchObject({ cause: ordinary });
          const retry = createSink();
          const accepted = await manager.start({
            identity: IDENTITY,
            request: REQUEST,
            sessionTarget,
            sink: retry.sink,
          });
          if (!accepted.ok) {
            throw new Error("known native refusal prevented legitimate retry");
          }
          accepted.launch();
          expect(await retry.terminal).toEqual(PROVIDER_ERROR);
          expect(begin).toHaveBeenCalledTimes(2);
          expect(complete).toHaveBeenCalledOnce();
          await manager.stop();
        }
      } finally {
        for (const restore of restores.toReversed()) {
          restore();
        }
        invalid = false;
        drain?.start();
        await Promise.allSettled([drain?.drained, manager.stop()]);
        drain?.release();
        begin.mockRestore();
        complete.mockRestore();
      }
    },
  );

  it.each(["shutdown", "successor"] as const)(
    "retains a native post-commit terminal result failure until the accepted provider drains (%s)",
    async (mode) => {
      const entered = createDeferred<AbortSignal>();
      const provider = createDeferred<WorkerInferenceTerminalOutcome>();
      const submitted = createDeferred<{ promise: ReturnType<WorkerInferenceStore["complete"]> }>();
      let committedOutcome: WorkerInferenceTerminalOutcome | undefined;
      const execute = vi.fn<WorkerInferenceExecutor>(async ({ signal }) => {
        entered.resolve(signal);
        return await provider.promise;
      });
      const manager = createWorkerInferenceManager({ execute, store });
      const begin = vi.spyOn(store, "begin");
      const originalComplete = store.complete;
      const complete = vi.spyOn(store, "complete").mockImplementation((...args) => {
        const promise = originalComplete(...args);
        submitted.resolve({ promise });
        return promise;
      });
      const { frames, sink } = createSink();
      let drain: AcceptedWorkerInferenceSessionDrain | undefined;
      let restoreReceiver: (() => void) | undefined;
      let terminalReplies = 0;
      const sessionTarget = {
        agentId: "main",
        sessionId: REQUEST.sessionId,
        sessionKey: "agent:main:inference-store",
        storePath: path.join(root, "sessions.sqlite"),
      };
      const successorRequest = {
        ...REQUEST,
        runId: "run-native-successor",
        turnId: "turn-native-successor",
      };
      const successorIdentity: WorkerConnectionIdentity = {
        ...IDENTITY,
        runId: successorRequest.runId,
        turnClaim: {
          ...IDENTITY.turnClaim!,
          runId: successorRequest.runId,
          claimId: "claim-native-successor",
        },
      };
      const startSuccessor = (nextSink: WorkerInferenceSink) =>
        manager.start({
          identity: successorIdentity,
          request: successorRequest,
          sessionTarget,
          sink: nextSink,
        });
      try {
        await manager.ready();
        const started = await manager.start({
          identity: IDENTITY,
          request: REQUEST,
          sessionTarget,
          sink,
        });
        if (!started.ok) {
          throw new Error(`start failed: ${started.reason}`);
        }
        started.launch();
        const signal = await entered.promise;
        const originalReceive = brokerReply.receiveSqliteWorkerReply;
        const receiver = vi
          .spyOn(brokerReply, "receiveSqliteWorkerReply")
          .mockImplementation((slot, reply, owner) => {
            if (
              slot.current?.request.type === "execute" &&
              slot.current.nativeDispatched &&
              reply.ok &&
              !reply.transfer &&
              !reply.input
            ) {
              const value: unknown = deserialize(reply.value);
              if (
                validateWorkerInferenceTerminalOutcome(value) &&
                value.type === "error" &&
                value.reason === "cancelled"
              ) {
                terminalReplies += 1;
                if (terminalReplies === 1) {
                  // The Worker reply reaches this receiver after COMMIT.
                  committedOutcome = value;
                  return originalReceive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
                }
              }
            }
            return originalReceive(slot, reply, owner);
          });
        restoreReceiver = () => receiver.mockRestore();
        const cancellation = manager.captureSessionCancellation(REQUEST.sessionId).cancel();
        const cancelled = Promise.allSettled([cancellation]);
        expect(signal.aborted).toBe(true);
        const { promise: completion } = await submitted.promise;
        const [completed] = await Promise.allSettled([completion]);
        if (!committedOutcome) {
          throw new Error(
            "native terminal completion settled without intercepting its committed result",
          );
        }
        if (completed.status !== "rejected") {
          throw new Error("corrupted native terminal result unexpectedly succeeded");
        }
        const failure: unknown = completed.reason;
        expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
        const [cancellationResult] = await cancelled;
        if (cancellationResult.status !== "rejected") {
          throw new Error("native uncertainty was lost during captured cancellation");
        }
        expect(cancellationResult.reason).toBe(failure);
        if (mode === "successor") {
          expect(await startSuccessor(createSink().sink)).toEqual({
            ok: false,
            reason: "provider-error",
          });
          expect(begin).toHaveBeenCalledOnce();
          expect(complete).toHaveBeenCalledOnce();
        }
        const acceptedDrain = manager.reserveSessionDrain(REQUEST.sessionId).accept();
        drain = acceptedDrain;
        let drainSettled = false;
        void drain.drained.then(
          () => {
            drainSettled = true;
          },
          () => {
            drainSettled = true;
          },
        );
        const drained = Promise.allSettled([drain.drained]);
        acceptedDrain.start();
        expect(signal.aborted).toBe(true);
        let stopSettled = false;
        const stopping = mode === "shutdown" ? manager.stop() : undefined;
        void stopping?.then(
          () => {
            stopSettled = true;
          },
          () => {
            stopSettled = true;
          },
        );
        const stopped = stopping ? Promise.allSettled([stopping]) : undefined;
        await expect(manager.cancel({ identity: IDENTITY, request: REQUEST })).resolves.toEqual({
          ok: false,
          reason: "provider-error",
        });
        expect(drainSettled).toBe(false);
        expect(stopSettled).toBe(false);
        expect(drain.hasWork()).toBe(true);
        expect(frames).toEqual([]);
        const readTerminal = () =>
          database.db
            .prepare(
              "SELECT state, terminal_json FROM worker_inference_turns WHERE session_id = ? AND run_epoch = ? AND run_id = ? AND turn_id = ?",
            )
            .all(REQUEST.sessionId, REQUEST.runEpoch, REQUEST.runId, REQUEST.turnId);
        expect(readTerminal()).toEqual([
          { state: "terminal", terminal_json: JSON.stringify(committedOutcome) },
        ]);

        provider.resolve(PROVIDER_ERROR);
        const [drainResult] = await drained;
        if (drainResult.status !== "rejected") {
          throw new Error("native uncertainty was lost during inference settlement");
        }
        expect(drainResult.reason).toBe(failure);
        if (stopped) {
          const [stopResult] = await stopped;
          if (stopResult.status !== "rejected") {
            throw new Error("native uncertainty was lost during shutdown");
          }
          expect(stopResult.reason).toBe(failure);
        }
        expect(complete).toHaveBeenCalledOnce();
        expect(terminalReplies).toBe(1);
        expect(execute).toHaveBeenCalledOnce();
        expect(frames).toEqual([]);
        expect(readTerminal()).toEqual([
          { state: "terminal", terminal_json: JSON.stringify(committedOutcome) },
        ]);
        if (mode === "successor") {
          drain.release();
          const changedFactsIdentity: WorkerConnectionIdentity = {
            ...IDENTITY,
            environmentId: "replacement-environment",
            turnClaim: {
              ...IDENTITY.turnClaim!,
              owner: {
                kind: "worker",
                environmentId: "replacement-environment",
                ownerEpoch: REQUEST.runEpoch,
              },
            },
          };
          for (const [identity, request] of [
            [IDENTITY, REQUEST],
            [
              changedFactsIdentity,
              { ...REQUEST, modelRef: { ...REQUEST.modelRef, model: "changed-request-hash" } },
            ],
          ] as const) {
            expect(
              await manager.start({ identity, request, sessionTarget, sink: createSink().sink }),
            ).toEqual({
              ok: false,
              reason: "provider-error",
            });
          }
          expect(begin).toHaveBeenCalledOnce();
          const successor = createSink();
          const accepted = await startSuccessor(successor.sink);
          if (!accepted.ok) {
            throw new Error("independent native successor was blocked after original settlement");
          }
          expect(accepted.result.status).toBe("accepted");
          accepted.launch();
          expect(await successor.terminal).toEqual(PROVIDER_ERROR);
          const replaySink = createSink();
          const replayed = await startSuccessor(replaySink.sink);
          if (!replayed.ok) {
            throw new Error("independent native successor could not replay");
          }
          expect(replayed.result.status).toBe("replayed");
          replayed.launch();
          expect(await replaySink.terminal).toEqual(PROVIDER_ERROR);
          const successorDrain = manager.reserveSessionDrain(REQUEST.sessionId).accept();
          successorDrain.start();
          await expect(successorDrain.drained).resolves.toBeUndefined();
          successorDrain.release();
          expect(begin).toHaveBeenCalledTimes(3);
          expect(complete).toHaveBeenCalledTimes(2);
          expect(execute).toHaveBeenCalledTimes(2);
          expect(terminalRunIds()).toEqual([REQUEST.runId, successorRequest.runId].toSorted());
          expect(readTerminal()).toEqual([
            { state: "terminal", terminal_json: JSON.stringify(committedOutcome) },
          ]);
          await expect(manager.stop()).rejects.toBe(failure);
          expect(complete).toHaveBeenCalledTimes(2);
          expect(terminalReplies).toBe(1);
        }
      } finally {
        restoreReceiver?.();
        provider.resolve(PROVIDER_ERROR);
        await Promise.allSettled([drain?.drained, manager.stop()]);
        drain?.release();
        complete.mockRestore();
        begin.mockRestore();
      }
    },
  );

  it("rejects another pending turn for the same session epoch and run", async () => {
    expect(await store.begin(BASE_INPUT)).toEqual({ kind: "claimed" });

    expect(
      await store.begin({
        ...BASE_INPUT,
        turnId: "turn-conflict",
        requestHash: "b".repeat(64),
      }),
    ).toEqual({ kind: "rejected", reason: "conflict" });
  });

  it.each([
    {
      limit: "older than maxAge",
      elapsedMs: 1_000,
      retention: { maxAgeMs: 500, maxRows: 10, maxBytes: 1_000_000 },
    },
    {
      limit: "beyond maxRows",
      elapsedMs: 1,
      retention: { maxAgeMs: 10_000, maxRows: 1, maxBytes: 1_000_000 },
    },
  ])("prunes terminal turns $limit", async ({ elapsedMs, retention }) => {
    await completeTurn("run-first");
    nowMs += elapsedMs;
    store = createWorkerInferenceStore({
      path: database.path,
      now: () => nowMs,
      retention,
    });

    await completeTurn("run-second");
    expect(terminalRunIds()).toEqual(["run-second"]);
  });

  it.each(["UTF-8", "UTF-16le", "UTF-16be"])(
    "prunes %s terminal turns by UTF-8 maxBytes and retains exact replay",
    async (encoding) => {
      if (encoding !== "UTF-8") {
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
        const databasePath = path.join(root, "encoded.sqlite");
        const seed = new DatabaseSync(databasePath);
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
        seed.close();
        database = openOpenClawStateDatabase({ path: databasePath });
        await initializeStore();
      }
      expect(database.db.prepare("PRAGMA encoding").get()?.encoding).toBe(encoding);
      const outcome: WorkerInferenceTerminalOutcome = {
        ...PROVIDER_ERROR,
        message: "問題🦞".repeat(64),
      };
      await completeTurn("run-first", outcome);
      nowMs += 1;
      const maxBytes = Buffer.byteLength(JSON.stringify(outcome), "utf8") * 2;
      store = createWorkerInferenceStore({
        path: database.path,
        now: () => nowMs,
        retention: { maxAgeMs: 10_000, maxRows: 10, maxBytes },
      });

      const second = await completeTurn("run-second", outcome);
      expect(terminalRunIds()).toEqual(["run-first", "run-second"]);
      store = createWorkerInferenceStore({
        path: database.path,
        now: () => nowMs,
        retention: { maxAgeMs: 10_000, maxRows: 10, maxBytes: maxBytes - 1 },
      });
      expect(await store.begin(second)).toEqual({ kind: "replay", outcome });
      expect(terminalRunIds()).toEqual(["run-second"]);
    },
  );

  it("prunes retention without hydrating cached terminal payloads", async () => {
    const outcome = { ...PROVIDER_ERROR, message: "🦞".repeat(128) };
    await completeTurn("run-first", outcome);
    await completeTurn("run-second", outcome);
    const counter = trackSqliteStatementExecutions(database.db, ["inference"], (query) =>
      query.includes("worker_inference_turns") ? "inference" : null,
    );
    try {
      const kernel = createWorkerInferenceStoreKernel({ db: database.db, now: () => nowMs });
      expect(kernel.begin({ ...BASE_INPUT, runId: "run-next" })).toEqual({ kind: "claimed" });
      expect(counter.rowCounts.inference).toBeGreaterThan(0);
      expect(counter.textBytes.inference).toBeLessThan(1024);
    } finally {
      counter.restore();
    }
    expect(terminalRunIds()).toEqual(["run-first", "run-second"]);
  });

  it("preserves the active identity while pruning after completion", async () => {
    store = createWorkerInferenceStore({
      path: database.path,
      now: () => nowMs,
      retention: { maxAgeMs: 0, maxRows: 0, maxBytes: 0 },
    });

    await completeTurn("run-active");
    expect(terminalRunIds()).toEqual(["run-active"]);
  });
});
