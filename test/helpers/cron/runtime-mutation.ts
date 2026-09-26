import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import type { CronRuntimeMutationType } from "../../../src/cron/store/runtime-worker.types.js";
import type { SqliteWorkerRequest } from "../../../src/infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../../src/infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "../../../src/state/openclaw-state-db.js";

export function loseFirstCronMutationReply(type: CronRuntimeMutationType = "cron.repairRuns") {
  let target: { worker: Worker; requestId: number; nonce: string } | undefined;
  let stopped: Promise<number> | undefined;
  let dropped = false;
  const attempts: string[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
  const originalPost = Worker.prototype.postMessage;
  // oxlint-disable-next-line typescript/unbound-method -- The intercepted message port remains the receiver.
  const originalOn = MessagePort.prototype.on;
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (
        isRecord(command) &&
        command.type === type &&
        isRecord(command.input) &&
        typeof command.input.nonce === "string"
      ) {
        attempts.push(
          Array.isArray(command.input.proposals) &&
            isRecord(command.input.proposals[0]) &&
            typeof command.input.proposals[0].jobId === "string"
            ? command.input.proposals[0].jobId
            : type,
        );
        target ??= { worker: this, requestId: request.id, nonce: command.input.nonce };
      }
    }
    return originalPost.call(this, request, transferList);
  });
  const on = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
    this: MessagePort,
    event,
    listener,
  ) {
    if (event !== "message") {
      return originalOn.call(this, event, listener);
    }
    return originalOn.call(this, event, function (this: MessagePort, ...args: unknown[]) {
      const message = args[0];
      const reply = isRecord(message) && message.type === "result" ? message.reply : undefined;
      if (
        !dropped &&
        target &&
        isRecord(reply) &&
        reply.id === target.requestId &&
        reply.ok === true &&
        reply.value instanceof Uint8Array
      ) {
        const result: unknown = deserialize(reply.value);
        if (isRecord(result) && result.nonce === target.nonce) {
          // Withhold only the successful reply; real commit receipts and native settlement still flow.
          dropped = true;
          stopped = target.worker.terminate();
          return;
        }
      }
      Reflect.apply(listener, this, args);
    });
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
        on.mockRestore();
      }
    },
  };
}

let cronJobWriteObserverId = 0;

export function observeCronJobWrites(
  jobId: string,
  observer: (state: { queuedAtMs?: number; runningAtMs?: number }) => void,
): () => void {
  const database = openOpenClawStateDatabase().db;
  const suffix = ++cronJobWriteObserverId;
  const functionName = `observe_cron_job_write_${suffix}`;
  const triggerName = `observe_cron_job_write_${suffix}`;
  database.function(functionName, (writtenJobId, stateJson) => {
    if (writtenJobId !== jobId || typeof stateJson !== "string") {
      return 0;
    }
    const state = JSON.parse(stateJson) as { queuedAtMs?: number; runningAtMs?: number };
    observer({
      ...(typeof state.queuedAtMs === "number" ? { queuedAtMs: state.queuedAtMs } : {}),
      ...(typeof state.runningAtMs === "number" ? { runningAtMs: state.runningAtMs } : {}),
    });
    return 0;
  });
  database.exec(`
    CREATE TEMP TRIGGER ${triggerName}
    AFTER UPDATE ON cron_jobs
    BEGIN
      SELECT ${functionName}(NEW.job_id, NEW.state_json);
    END;
  `);
  // TEMP triggers cover the synchronous reservation writer only. Worker mutations
  // supply their actual rows after SQL has run but before their retained commit
  // admission. Observe that boundary without replacing SQL, grants, or outcomes.
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admission = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          request.facts.bytes instanceof Uint8Array
        ) {
          const outcome: unknown = deserialize(request.facts.bytes);
          if (isRecord(outcome)) {
            const jobs = isRecord(outcome.activation)
              ? [outcome.activation.job]
              : Array.isArray(outcome.jobs)
                ? outcome.jobs
                : [];
            for (const job of jobs) {
              if (isRecord(job) && job.id === jobId && isRecord(job.state)) {
                observer({
                  ...(typeof job.state.queuedAtMs === "number"
                    ? { queuedAtMs: job.state.queuedAtMs }
                    : {}),
                  ...(typeof job.state.runningAtMs === "number"
                    ? { runningAtMs: job.state.runningAtMs }
                    : {}),
                });
              }
            }
          }
        }
        admit(request, grant);
      }, attachment),
    );
  return () => {
    admission.mockRestore();
    database.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  };
}
