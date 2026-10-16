import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
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
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import type { WorkerConnectionIdentity, WorkerInferenceExecutor } from "./connection-identity.js";
import type { AcceptedWorkerInferenceSessionDrain } from "./inference-control-internal.js";
import {
  createWorkerInferenceStore,
  type WorkerInferenceStore,
  type WorkerInferenceTurnInput,
} from "./inference-store.js";
import { createWorkerInferenceStoreKernel } from "./inference-store.kernel.js";
import { createWorkerInferenceManager, type WorkerInferenceSink } from "./inference.js";
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
function identityFor(
  runId = REQUEST.runId,
  environmentId = ENVIRONMENT_ID,
  claimId = "claim-store",
): WorkerConnectionIdentity {
  return {
    environmentId,
    credentialHash: ["fixture", "digest"].join("-"),
    bundleHash: ["fixture", "bundle", "digest"].join("-"),
    sessionId: REQUEST.sessionId,
    runId,
    turnClaim: {
      sessionId: REQUEST.sessionId,
      claimId,
      runId,
      placementGeneration: 4,
      owner: { kind: "worker", environmentId, ownerEpoch: REQUEST.runEpoch },
    },
    ownerEpoch: REQUEST.runEpoch,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-inference-v1"],
    credentialExpiresAtMs: 10_000,
  };
}
const IDENTITY = identityFor();
const PROVIDER_ERROR: WorkerInferenceTerminalOutcome = {
  type: "error",
  reason: "provider-error",
  message: "Provider request failed",
};
const REJECTED_START = { ok: false, reason: "provider-error" };

assert(IDENTITY.turnClaim, "inference fixture requires a turn claim");
const BASE_INPUT: WorkerInferenceTurnInput = {
  environmentId: ENVIRONMENT_ID,
  sessionId: REQUEST.sessionId,
  runEpoch: REQUEST.runEpoch,
  runId: REQUEST.runId,
  turnId: REQUEST.turnId,
  requestHash: createHash("sha256")
    .update(`${serializeWorkerSessionTurnClaim(IDENTITY.turnClaim)}\0${stableStringify(REQUEST)}`)
    .digest("hex"),
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

function rejectedReason([settled]: PromiseSettledResult<unknown>[]): unknown {
  assert(settled.status === "rejected", "native operation unexpectedly fulfilled");
  return settled.reason;
}

function observeSettlement(promise: Promise<unknown> | undefined) {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void promise?.then(markSettled, markSettled);
  return () => settled;
}

describe("worker inference SQLite store", async () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let nowMs: number;
  let store: WorkerInferenceStore;

  function startInference(
    manager: ReturnType<typeof createWorkerInferenceManager>,
    sink: WorkerInferenceSink,
    overrides: Partial<Parameters<typeof manager.start>[0]> = {},
  ) {
    return manager.start({
      identity: IDENTITY,
      request: REQUEST,
      sink,
      sessionTarget: {
        agentId: "main",
        sessionId: REQUEST.sessionId,
        sessionKey: "agent:main:inference-store",
        storePath: path.join(root, "sessions.sqlite"),
      },
      ...overrides,
    });
  }

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-inference-store-"));
    nowMs = 1_000;
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const environments = await createWorkerEnvironmentStore({ database, now: () => nowMs });
    await environments.createIntent({
      environmentId: ENVIRONMENT_ID,
      providerId: "fixture-provider",
      profileId: "fixture-profile",
      profileSnapshot: { settings: {}, lifetime: { idleMinutes: 10 } },
      provisionOperationId: "fixture-operation",
    });
    store = createWorkerInferenceStore({ path: database.path, now: () => nowMs });
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
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
  it("retains process ownership checks when the captured environment permits writes", async () => {
    const options = {
      path: database.path,
      env: { OPENCLAW_STATE_DIR: root, OPENCLAW_SUPERVISOR_MODE: "external" },
    };
    claimOpenClawStateOwnership("inference-owner", options);
    expect(openOpenClawStateDatabase(options)).toBe(database);
    await expect(
      createWorkerInferenceStore(options).recoverPending(PROVIDER_ERROR),
    ).rejects.toThrow("is externally supervised by inference-owner");
  });

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
    "settles native begin after authority failure (%s)",
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
      let invalid = false;
      let target: { worker: Worker; id: number; actor: number } | undefined;
      let refusalReplies = 0;
      let drain: AcceptedWorkerInferenceSessionDrain | undefined;
      const restores: Array<() => void> = [];
      try {
        await manager.ready();
        const originalPost = Worker.prototype.postMessage;
        const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
          this: Worker,
          ...args: Parameters<Worker["postMessage"]>
        ) {
          const request: unknown = args[0];
          if (
            target ||
            !isRecord(request) ||
            request.type !== "execute" ||
            !types.isUint8Array(request.input)
          ) {
            return Reflect.apply(originalPost, this, args);
          }
          const command: unknown = deserialize(request.input);
          if (!isRecord(command) || command.type !== "workerInference.begin") {
            return Reflect.apply(originalPost, this, args);
          }
          assert(
            typeof request.id === "number" &&
              typeof request.actor === "number" &&
              request.operationAdmission instanceof MessagePort,
            "native begin omitted its operation admission",
          );
          Reflect.apply(originalPost, this, args);
          target = { worker: this, id: request.id, actor: request.actor };
          invalid = true;
          dispatched.resolve();
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
              job.custody.dispatched &&
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
        const started = startInference(manager, initial.sink, {
          revalidate: () => {
            if (invalid) {
              throw ordinary;
            }
            return null;
          },
        });
        const { promise } = await submitted.promise;
        const failBeforeDispatch = () => {
          throw new Error("begin settled before native dispatch");
        };
        const endedBeforeDispatch = promise.then(failBeforeDispatch, failBeforeDispatch);
        await Promise.race([dispatched.promise, endedBeforeDispatch]);
        drain = manager.reserveSessionDrain(REQUEST.sessionId).accept();
        const drained = Promise.allSettled([drain.drained]);
        const native = rejectedReason(await Promise.allSettled([promise]));
        expect(refusalReplies).toBe(1);
        expect(hasSqliteWorkerOutcomeUnknown(native)).toBe(mode === "lost-refusal-reply");
        expect(await started).toEqual(REJECTED_START);
        drain.start();
        const settled = rejectedReason(await drained);
        expect(hasSqliteWorkerOutcomeUnknown(settled)).toBe(mode === "lost-refusal-reply");
        expect(complete).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(initial.frames).toEqual([]);
        expect(database.db.prepare("SELECT turn_id FROM worker_inference_turns").all()).toEqual([]);
        drain.release();
        invalid = false;
        if (mode === "lost-refusal-reply") {
          expect(errorGraph(settled)).toContain(ordinary);
          expect(errorGraph(settled)).toContain(native);
          expect(await startInference(manager, initial.sink)).toEqual(REJECTED_START);
          expect(begin).toHaveBeenCalledOnce();
          expect(complete).not.toHaveBeenCalled();
          const stopped = rejectedReason(await Promise.allSettled([manager.stop()]));
          expect(hasSqliteWorkerOutcomeUnknown(stopped)).toBe(true);
          expect(errorGraph(stopped)).toContain(ordinary);
          expect(errorGraph(stopped)).toContain(native);
        } else {
          expect(settled).toBe(ordinary);
          expect(native).toMatchObject({ cause: ordinary });
          const retry = createSink();
          const accepted = await startInference(manager, retry.sink);
          assert(accepted.ok, "known native refusal prevented legitimate retry");
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
    "retains native post-commit failure until provider drain (%s)",
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
      const successorRequest = {
        ...REQUEST,
        runId: "run-native-successor",
        turnId: "turn-native-successor",
      };
      const successorIdentity = identityFor(
        successorRequest.runId,
        ENVIRONMENT_ID,
        "claim-native-successor",
      );
      const startSuccessor = (nextSink: WorkerInferenceSink) =>
        startInference(manager, nextSink, {
          identity: successorIdentity,
          request: successorRequest,
        });
      try {
        await manager.ready();
        const started = await startInference(manager, sink);
        assert(started.ok, "inference start failed");
        started.launch();
        const signal = await entered.promise;
        const originalReceive = brokerReply.receiveSqliteWorkerReply;
        const receiver = vi
          .spyOn(brokerReply, "receiveSqliteWorkerReply")
          .mockImplementation((slot, reply, owner) => {
            if (
              slot.current?.request.type === "execute" &&
              slot.current.custody.dispatched &&
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
        const failure = rejectedReason(await Promise.allSettled([completion]));
        assert(committedOutcome, "terminal completion missed committed result");
        expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
        expect(rejectedReason(await cancelled)).toBe(failure);
        if (mode === "successor") {
          expect(await startSuccessor(createSink().sink)).toEqual(REJECTED_START);
          expect(begin).toHaveBeenCalledOnce();
          expect(complete).toHaveBeenCalledOnce();
        }
        const acceptedDrain = manager.reserveSessionDrain(REQUEST.sessionId).accept();
        drain = acceptedDrain;
        const drainSettled = observeSettlement(drain.drained);
        const drained = Promise.allSettled([drain.drained]);
        acceptedDrain.start();
        expect(signal.aborted).toBe(true);
        const stopping = mode === "shutdown" ? manager.stop() : undefined;
        const stopSettled = observeSettlement(stopping);
        const stopped = stopping ? Promise.allSettled([stopping]) : undefined;
        await expect(manager.cancel({ identity: IDENTITY, request: REQUEST })).resolves.toEqual(
          REJECTED_START,
        );
        expect(drainSettled()).toBe(false);
        expect(stopSettled()).toBe(false);
        expect(drain.hasWork()).toBe(true);
        expect(frames).toEqual([]);
        const expectTerminal = () => {
          const rows = database.db
            .prepare(
              "SELECT state, terminal_json FROM worker_inference_turns WHERE session_id = ? AND run_epoch = ? AND run_id = ? AND turn_id = ?",
            )
            .all(REQUEST.sessionId, REQUEST.runEpoch, REQUEST.runId, REQUEST.turnId);
          expect(rows).toEqual([
            { state: "terminal", terminal_json: JSON.stringify(committedOutcome) },
          ]);
        };
        expectTerminal();

        provider.resolve(PROVIDER_ERROR);
        expect(rejectedReason(await drained)).toBe(failure);
        if (stopped) {
          expect(rejectedReason(await stopped)).toBe(failure);
        }
        expect(complete).toHaveBeenCalledOnce();
        expect(terminalReplies).toBe(1);
        expect(execute).toHaveBeenCalledOnce();
        expect(frames).toEqual([]);
        expectTerminal();
        if (mode === "successor") {
          drain.release();
          const changedFactsIdentity = identityFor(REQUEST.runId, "replacement-environment");
          for (const [identity, request] of [
            [IDENTITY, REQUEST],
            [
              changedFactsIdentity,
              { ...REQUEST, modelRef: { ...REQUEST.modelRef, model: "changed-request-hash" } },
            ],
          ] as const) {
            expect(await startInference(manager, createSink().sink, { identity, request })).toEqual(
              REJECTED_START,
            );
          }
          expect(begin).toHaveBeenCalledOnce();
          for (const status of ["accepted", "replayed"]) {
            const successor = createSink();
            const accepted = await startSuccessor(successor.sink);
            assert(accepted.ok, "independent native successor was blocked");
            expect(accepted.result.status).toBe(status);
            accepted.launch();
            expect(await successor.terminal).toEqual(PROVIDER_ERROR);
          }
          const successorDrain = manager.reserveSessionDrain(REQUEST.sessionId).accept();
          successorDrain.start();
          await expect(successorDrain.drained).resolves.toBeUndefined();
          successorDrain.release();
          expect(begin).toHaveBeenCalledTimes(3);
          expect(complete).toHaveBeenCalledTimes(2);
          expect(execute).toHaveBeenCalledTimes(2);
          expect(terminalRunIds()).toEqual([REQUEST.runId, successorRequest.runId].toSorted());
          expectTerminal();
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
    for (const runId of ["run-first", "run-second"]) {
      const input = { ...BASE_INPUT, runId, turnId: `turn-${runId}` };
      expect(await store.begin(input)).toEqual({ kind: "claimed" });
      expect(await store.complete({ ...input, outcome })).toEqual(outcome);
    }
    const counter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["inference"],
      (query) => (query.includes("worker_inference_turns") ? "inference" : null),
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
