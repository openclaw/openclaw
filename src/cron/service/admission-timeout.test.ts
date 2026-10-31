import { deserialize } from "node:v8";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { stop } from "./ops-lifecycle.js";
import { runMissedJobs } from "./timer.test-support.js";

function stallCronHostCallbacks() {
  const held = createDeferred();
  const delayed: Array<() => void> = [];
  const ports = new WeakMap<MessagePort, { paused: boolean }>();
  const restores: Array<{ mockRestore(): void }> = [];
  let stalling = true;
  const mutationTypes = new Set([
    "cron.schedulerStart",
    "cron.requestRuns",
    "cron.drainQueue",
    "cron.finalizeRuns",
    "cron.cancelRequests",
  ]);
  const createWorker = workerCpu.createCpuTrackedWorker;
  const workers = vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((...args) => {
    const worker = createWorker(...args);
    const nativePost = worker.postMessage.bind(worker);
    const nativeEmit = worker.emit.bind(worker);
    const requests = new Set<number>();
    const reply = vi.spyOn(worker, "emit").mockImplementation((event, ...eventArgs) => {
      const message: unknown = eventArgs[0];
      if (
        stalling &&
        event === "message" &&
        isRecord(message) &&
        typeof message.id === "number" &&
        requests.has(message.id) &&
        message.ok === true &&
        message.value instanceof Uint8Array
      ) {
        delayed.push(() => nativeEmit(event, ...eventArgs));
        held.resolve();
        return true;
      }
      return nativeEmit(event, ...eventArgs);
    });
    const post = vi.spyOn(worker, "postMessage").mockImplementation((message, transferList) => {
      const request: unknown = message;
      const command: unknown =
        isRecord(request) && request.type === "execute" && request.input instanceof Uint8Array
          ? deserialize(request.input)
          : undefined;
      const cronMutation =
        isRecord(command) && typeof command.type === "string" && mutationTypes.has(command.type);
      if (cronMutation && isRecord(request) && typeof request.id === "number") {
        requests.add(request.id);
      }
      if (cronMutation && isRecord(request) && request.operationAdmission instanceof MessagePort) {
        const receiver = ports.get(request.operationAdmission);
        if (receiver) {
          receiver.paused = true;
        }
      }
      nativePost(message, transferList);
    });
    restores.push(reply, post);
    return worker;
  });
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admissions = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) => {
      const receiver = { paused: false };
      const admission = createAdmission((request, grant) => {
        if (
          stalling &&
          receiver.paused &&
          (request.stage === "transaction" || request.stage === "commit")
        ) {
          // Delay the real admission decision without replacing the transport or SQLite worker.
          delayed.push(() => admit(request, grant));
          held.resolve();
        } else {
          admit(request, grant);
        }
      }, attachment);
      ports.set(admission.port, receiver);
      return admission;
    });
  return {
    held: held.promise,
    release() {
      stalling = false;
      for (const deliver of delayed.splice(0)) {
        deliver();
      }
    },
    restore() {
      admissions.mockRestore();
      workers.mockRestore();
      for (const restore of restores.toReversed()) {
        restore.mockRestore();
      }
    },
  };
}

it("finishes startup and writes update history while cron host callbacks are stalled", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "cron-startup-independent-writers" }, async (fixture) => {
    const fault = stallCronHostCallbacks();
    const now = 1_800_000_000_000;
    const storePath = fixture.statePath("cron", "jobs.json");
    const dueJob = (id: string) => createDueIsolatedJob({ id, nowMs: now, nextRunAtMs: now });
    const deferred = dueJob("deferred-startup");
    const immediate = dueJob("immediate-startup");
    immediate.payload = { kind: "command", argv: ["echo", "synthetic"] };
    const runCommandJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "main",
      nowMs: () => now,
      runCommandJob,
      runIsolatedAgentJob: async () => {
        throw new Error("Deferred startup must not execute the payload");
      },
    });
    let settled: Promise<unknown> | undefined;
    try {
      await saveCronStore(storePath, { version: 1, jobs: [deferred, immediate] });
      const options = { env: fixture.env, busyTimeoutMs: 0 };
      const update = createUpdateRun({ trigger: "cli" }, options);
      const startup = runMissedJobs(state, { deferAgentWork: true });
      settled = Promise.allSettled([startup]);
      await withinTest(
        awaitGateBeforeSettlement(
          fault.held,
          startup,
          "Startup completed without pausing its host",
        ),
        signal,
      );
      // Update history uses the shared-state writer that a pending cron response must not hold.
      recordUpdateRunStep(
        update.runId,
        { step: "cron-independent-history", status: "completed", endedAtMs: now },
        options,
      );
      fault.release();
      expect(await withinTest(settled, signal)).toMatchObject([{ status: "fulfilled" }]);
      expect(runCommandJob).toHaveBeenCalledOnce();
      const jobs = (await loadCronStore(storePath)).jobs;
      expect(jobs.find(({ id }) => id === deferred.id)?.state.startupCatchupAtMs).toBeGreaterThan(
        now,
      );
      expect(jobs.find(({ id }) => id === immediate.id)?.state.lastRunStatus).toBe("ok");
      const db = openOpenClawStateDatabase().db;
      expect(getUpdateRun(update.runId, options)?.steps).toContainEqual(
        expect.objectContaining({ step: "cron-independent-history", status: "completed" }),
      );
      const receipts = db
        .prepare("SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
        .all(cronStoreKey(storePath), immediate.id);
      expect(receipts).toEqual([{ status: "ok" }]);
    } finally {
      fault.release();
      fault.restore();
      stop(state);
      await settled;
      await state.op;
    }
  });
});
