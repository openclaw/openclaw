import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import * as cronStore from "../../../src/cron/store.js";
import { cronStoreKey } from "../../../src/cron/store/key.js";
import type { CronRuntimeMutationType } from "../../../src/cron/store/runtime-worker.types.js";
import type { SqliteWorkerRequest } from "../../../src/infra/sqlite-worker-contract.js";
import { openOpenClawStateDatabase } from "../../../src/state/openclaw-state-db.js";

export function observeCronStoreCommits(storePath: string, observer: () => void): () => void {
  const storeKey = cronStoreKey(storePath);
  const noteCommit = cronStore.noteCronJobsStoreCommit;
  const publication = vi
    .spyOn(cronStore, "noteCronJobsStoreCommit")
    .mockImplementation((committedStoreKey) => {
      noteCommit(committedStoreKey);
      if (committedStoreKey === storeKey) {
        observer();
      }
    });
  return () => publication.mockRestore();
}

export function loseFirstCronMutationReply(type: CronRuntimeMutationType = "cron.repairRun") {
  let target: { worker: Worker; requestId: number } | undefined;
  let stopped: Promise<number> | undefined;
  let dropped = false;
  const attempts: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
  const originalPost = Worker.prototype.postMessage;
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
  const originalEmit = Worker.prototype.emit;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (isRecord(command) && command.type === type && isRecord(command.input)) {
        attempts.push(
          isRecord(command.input.proposal) && typeof command.input.proposal.jobId === "string"
            ? command.input.proposal.jobId
            : type,
        );
        target ??= { worker: this, requestId: request.id };
      }
    }
    return originalPost.call(this, request, transferList);
  });
  const emit = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event,
    ...args: unknown[]
  ) {
    const reply = args[0];
    if (
      event === "message" &&
      !dropped &&
      target?.worker === this &&
      isRecord(reply) &&
      reply.id === target.requestId &&
      reply.ok === true &&
      reply.value instanceof Uint8Array
    ) {
      const result: unknown = deserialize(reply.value);
      if (isRecord(result) && "outcome" in result) {
        // Lose the successful reply after the real worker committed; never fabricate a rollback.
        dropped = true;
        stopped = target.worker.terminate();
        return true;
      }
    }
    return originalEmit.call(this, event, ...args);
  });
  return {
    attempts,
    wasDropped: () => dropped,
    waitForExit: () => stopped,
    async close() {
      if (target) {
        stopped ??= target.worker.terminate();
      }
      try {
        await stopped;
      } finally {
        post.mockRestore();
        emit.mockRestore();
      }
    },
  };
}

/** Observe persisted state after a real cron write has committed. */
export function observeCronJobCommits(
  jobId: string,
  observer: (state: { queuedAtMs?: number; runningAtMs?: number }) => void,
): () => void {
  const database = openOpenClawStateDatabase().db;
  const read = (storeKey: string) =>
    database
      .prepare(
        "SELECT job_json, state_json, updated_at FROM cron_jobs WHERE store_key = ? AND job_id = ?",
      )
      .get(storeKey, jobId);
  const previous = new Map(
    database
      .prepare("SELECT store_key, job_json, state_json, updated_at FROM cron_jobs WHERE job_id = ?")
      .all(jobId)
      .map(({ store_key, ...row }) => [store_key, JSON.stringify(row)]),
  );
  const noteCommit = cronStore.noteCronJobsStoreCommit;
  const publication = vi
    .spyOn(cronStore, "noteCronJobsStoreCommit")
    .mockImplementation((storeKey) => {
      noteCommit(storeKey);
      const row = read(storeKey);
      const current = JSON.stringify(row);
      if (current === previous.get(storeKey) || typeof row?.state_json !== "string") {
        return;
      }
      previous.set(storeKey, current);
      const state = JSON.parse(row.state_json) as { queuedAtMs?: number; runningAtMs?: number };
      observer(state);
    });
  return () => publication.mockRestore();
}
