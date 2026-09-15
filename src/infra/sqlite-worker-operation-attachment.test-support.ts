import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { createDeferredCore } from "../shared/deferred.js";
import {
  decodeSqliteWorkerReplyError,
  decodeSqliteWorkerReplyValue,
  dispatchSqliteWorkerJob,
  settleSqliteWorkerJob,
} from "./sqlite-worker-broker-reply.js";
import type { Job } from "./sqlite-worker-broker.types.js";
import {
  createSqliteWorkerClient,
  runSqliteWorkerClientOperation,
} from "./sqlite-worker-client.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  type SqliteWorkerReply,
} from "./sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
} from "./sqlite-worker-operation-admission.js";
import type { AttachmentFixtureOperations } from "./sqlite-worker-operation-attachment-backend.test-support.js";

/** Drive the actual client serializer, broker framing, and generic worker with a JS-only backend. */
export async function runSqliteWorkerAttachmentFramingProof(databasePath: string) {
  assert.equal(existsSync(databasePath), false);
  const worker = new Worker(new URL("./sqlite-store.worker.ts", import.meta.url), {
    execArgv: process.versions.bun ? [] : ["--import", import.meta.resolve("tsx/esm")],
  });
  let nextId = 0;
  let current: Job | undefined;
  let observation: Int32Array | undefined;
  let nextFrames = 0;
  let admissionRequests = 0;
  const settlements: Promise<unknown>[] = [];
  const exited = createDeferredCore();
  let didExit = false;
  let stopping: Promise<void> | undefined;
  let workerFailure: Error | undefined;
  let opened = false;
  let closed = false;
  function stopWorker(): Promise<void> {
    stopping ??= (async () => {
      if (!didExit) {
        await worker.terminate();
      }
      await exited.promise;
    })();
    return stopping;
  }
  function failWorker(error: unknown) {
    workerFailure ??=
      error instanceof Error ? error : new Error("JS fixture worker failed", { cause: error });
    const job = current;
    current = undefined;
    const reject = (failure: unknown) => {
      if (!job) {
        return;
      }
      try {
        settleSqliteWorkerJob(
          job,
          failure,
          undefined,
          job.nativeDispatched
            ? { kind: "unknown", error: failure }
            : { kind: "not-entered", error: failure },
        );
      } catch (cleanupError) {
        job.reject(
          new AggregateError([failure, cleanupError], "Fixture job cleanup failed", {
            cause: failure,
          }),
        );
      }
    };
    // This backend is JS-only; join its exit before releasing the original job.
    void stopWorker().then(
      () => reject(error),
      (cleanupError: unknown) =>
        reject(
          new AggregateError([error, cleanupError], "Fixture worker cleanup failed", {
            cause: error,
          }),
        ),
    );
  }
  worker.on("exit", () => {
    didExit = true;
    exited.resolve();
    if (!stopping && !closed) {
      failWorker(new Error("JS fixture worker exited before completing its lifecycle"));
    }
  });
  worker.on("error", failWorker);
  worker.on("message", (reply: SqliteWorkerReply) => {
    try {
      const job = current;
      assert(job);
      assert.equal(reply.id, job.request.id);
      if (!reply.ok) {
        failWorker(decodeSqliteWorkerReplyError(job, reply.error));
        return;
      }
      if (reply.input === "next") {
        assert(observation);
        assert.equal(
          Atomics.load(observation, 0),
          0,
          "Backend must not execute partial command frames",
        );
        nextFrames++;
      }
      const result = decodeSqliteWorkerReplyValue(job, reply);
      if (result.type === "continue") {
        worker.postMessage(result.request, []);
      } else {
        settleSqliteWorkerJob(job, undefined, result.value);
        current = undefined;
      }
    } catch (error) {
      failWorker(error);
    }
  });
  function send(request: Job["request"], createAdmission?: SqliteWorkerAdmissionFactory) {
    if (workerFailure !== undefined) {
      return Promise.reject(workerFailure);
    }
    assert.equal(current, undefined);
    const result = createDeferredCore<unknown>();
    const job: Job = {
      request,
      createAdmission,
      bytes: "input" in request ? request.input.byteLength : 0,
      resolve: result.resolve,
      reject: result.reject,
      detach() {},
    };
    current = job;
    try {
      dispatchSqliteWorkerJob(worker, job);
    } catch (error) {
      failWorker(error);
    }
    return result.promise;
  }
  const failures: unknown[] = [];
  const receipts: Array<{ payloadBytes: number; result: unknown; frames: number }> = [];
  try {
    await send({
      id: ++nextId,
      actor: 1,
      type: "open",
      moduleUrl: new URL(
        "./sqlite-worker-operation-attachment-backend.test-support.ts",
        import.meta.url,
      ).href,
      databasePath,
      input: serialize(undefined),
    });
    opened = true;
    const { store, client } = createSqliteWorkerClient<AttachmentFixtureOperations>({
      isDraining: () => false,
      isAvailable: () => !closed,
      dispatch: (payload, _signal, _scope, assertCurrent, createAdmission) => {
        assertCurrent?.();
        return send({ type: "execute", actor: 1, id: ++nextId, input: payload }, createAdmission);
      },
      release: async () => {
        await send({ type: "close", actor: 1, id: ++nextId });
        closed = true;
      },
    });
    for (const size of [32, SQLITE_WORKER_MAX_MESSAGE_BYTES + 1]) {
      const word = new Int32Array(new SharedArrayBuffer(32));
      observation = word;
      nextFrames = 0;
      const value = "x".repeat(size);
      const result = await runSqliteWorkerClientOperation<AttachmentFixtureOperations, unknown>(
        client,
        (scope) => scope.execute({ type: "inspect", input: { value } }),
        undefined,
        () => () => {},
        undefined,
        (operation) => {
          settlements.push(operation.settled);
          return {
            admission: createSqliteWorkerOperationAdmission(
              (request, grant) => {
                assert.deepEqual(request, { stage: "prepare", facts: "ordinary-js-backend" });
                admissionRequests++;
                assert.equal(grant(), true);
              },
              { label: "ordinary-attachment", word: word.buffer },
            ),
            nativeLocations: [],
          };
        },
      );
      assert.equal(Atomics.load(word, 0), 1, "Transferred attachment must share the original word");
      assert.deepEqual(result, {
        length: size,
        digest: createHash("sha256").update(value).digest("hex"),
        executions: receipts.length + 1,
      });
      if (size > SQLITE_WORKER_MAX_MESSAGE_BYTES) {
        assert(nextFrames > 1);
      } else {
        assert.equal(nextFrames, 0);
      }
      receipts.push({ payloadBytes: size, result, frames: nextFrames });
    }
    await store.close();
    assert.equal(admissionRequests, 2);
    assert.deepEqual(await Promise.all(settlements), [
      { kind: "completed" },
      { kind: "completed" },
    ]);
  } catch (error) {
    failures.push(error);
  } finally {
    if (opened && !closed && !stopping && current === undefined) {
      try {
        await send({ type: "close", actor: 1, id: ++nextId });
        closed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    // Normal close is acknowledged first. Harness errors still retire this JS-only worker.
    try {
      await stopWorker();
    } catch (error) {
      if (!failures.includes(error)) {
        failures.push(error);
      }
    }
    if (workerFailure !== undefined && !failures.includes(workerFailure)) {
      failures.push(workerFailure);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Attachment proof and cleanup failed", {
      cause: failures[0],
    });
  }
  assert.equal(existsSync(databasePath), false, "JS-only backend must never create SQLite state");
  return { receipts, admissionRequests, backendClosed: closed, databaseCreated: false };
}
