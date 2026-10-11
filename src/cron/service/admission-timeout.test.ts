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
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { stop } from "./ops-lifecycle.js";
import { runMissedJobs } from "./timer-catchup.js";

function stallCronHostCallbacks() {
  const submitted = createDeferred();
  const held = createDeferred();
  const delayed: Array<() => void> = [];
  const ports = new WeakMap<MessagePort, { paused: boolean }>();
  const restores: Array<() => void> = [];
  let stalling = true;
  const mutationTypes = new Set([
    "cron.planStartup",
    "cron.reserveRuns",
    "cron.activateRun",
    "cron.finalizeRuns",
    "cron.releaseReservations",
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
      if (cronMutation) {
        submitted.resolve();
      }
    });
    restores.push(() => reply.mockRestore());
    restores.push(() => post.mockRestore());
    return worker;
  });
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const admissions = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((...args) => {
      const receiver = { paused: false };
      const listening = vi.spyOn(MessagePort.prototype, "on").mockImplementation(function (
        this: MessagePort,
        event,
        listener,
      ) {
        if (event !== "message") {
          return this.addListener(event, listener);
        }
        return this.addListener("message", function (this: MessagePort, message: unknown) {
          if (
            stalling &&
            receiver.paused &&
            isRecord(message) &&
            (message.stage === "transaction" || message.stage === "commit")
          ) {
            // Hold the real receiver; the worker keeps its actual SQLite transaction and decision.
            delayed.push(() => listener.call(this, message));
            held.resolve();
            return;
          }
          listener.call(this, message);
        });
      });
      try {
        const admission = createAdmission(...args);
        ports.set(admission.port, receiver);
        return admission;
      } finally {
        listening.mockRestore();
      }
    });
  return {
    submitted: submitted.promise,
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
        restore();
      }
    },
  };
}

it("finishes startup, state writes, and update history while cron host callbacks are stalled", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "cron-startup-independent-writers" }, async (fixture) => {
    const fault = stallCronHostCallbacks();
    const now = 1_800_000_000_000;
    const storePath = fixture.statePath("cron", "jobs.json");
    const deferred = createDueIsolatedJob({ id: "deferred-startup", nowMs: now, nextRunAtMs: now });
    const immediate = createDueIsolatedJob({
      id: "immediate-startup",
      nowMs: now,
      nextRunAtMs: now,
    });
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
      settled = startup.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      await withinTest(
        awaitGateBeforeSettlement(fault.submitted, startup, "Startup skipped its worker mutation"),
        signal,
      );
      await withinTest(
        awaitGateBeforeSettlement(
          fault.held,
          startup,
          "Startup completed without pausing its host",
        ),
        signal,
      );
      // A pending host response must never retain the writer needed by state and update history.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          ).run("cron-independent-writer", JSON.stringify("saved"), now);
        },
        { env: fixture.env },
        { busyTimeoutMs: 0 },
      );
      recordUpdateRunStep(
        update.runId,
        { step: "cron-independent-history", status: "completed", endedAtMs: now },
        options,
      );
      fault.release();
      expect(await withinTest(settled, signal)).toEqual({ ok: true });
      expect(runCommandJob).toHaveBeenCalledOnce();
      const jobs = (await loadCronStore(storePath)).jobs;
      expect(jobs.find(({ id }) => id === deferred.id)?.state.startupCatchupAtMs).toBeGreaterThan(
        now,
      );
      expect(jobs.find(({ id }) => id === immediate.id)?.state.lastRunStatus).toBe("ok");
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("cron-independent-writer"),
      ).toEqual({ value_json: JSON.stringify("saved") });
      expect(getUpdateRun(update.runId, options)?.steps).toContainEqual(
        expect.objectContaining({ step: "cron-independent-history", status: "completed" }),
      );
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
          .all(cronStoreKey(storePath), immediate.id),
      ).toEqual([{ status: "ok" }]);
    } finally {
      fault.release();
      fault.restore();
      stop(state);
      await settled;
      await state.op;
    }
  });
});
