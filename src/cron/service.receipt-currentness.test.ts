import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import * as nativeWorkers from "../infra/worker-native-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearCronJobActive } from "./active-jobs.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import {
  assertServiceCronRunReceiptCurrent,
  markServiceCronJobActive,
} from "./service/run-receipts.js";
import { createCronServiceState } from "./service/state.js";
import { saveCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import {
  activateCronRunReceiptInDatabase,
  assertCronRunReceiptCurrentInDatabase,
  CronRunReceiptRevisionError,
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptAsync,
} from "./store/run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "./store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "./types.js";

it("keeps claimed revision separate from current message and grant facts in worker replies", async () => {
  await withOpenClawTestState({ label: "cron-receipt-authority-facts" }, async (fixture) => {
    const job: CronStoredJob = makeCronReceiptJob("separate-authority-revisions");
    job.payload = {
      kind: "agentTurn",
      message: "read synthetic messages",
      toolsAllow: ["message"],
    };
    job.owner = { sessionKey: "agent:alpha:local", accountId: "synthetic" };
    job.scheduledToolPolicy = {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:alpha:local",
      ownerAccountId: "synthetic",
    };
    job.toolsAllowProvenance = {
      version: 1,
      source: "authenticated-requester",
      callerOrigin: { kind: "local" },
    };
    const storePath = fixture.statePath("cron", "jobs.json");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const handle = claimCronRunReceiptForTest(storePath, job, 1);
    const context = captureOpenClawStateReadWorkerContext();
    const read = async (ownerPid = handle.ownerPid) => {
      const result = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        {
          type: "cron.currentReceipt",
          handle: { ...handle, ownerPid },
          includeJob: true,
          includeAvailability: true,
        },
        { context, current: true },
      );
      if (!result?.ok || result.type !== "cron.currentReceipt") {
        throw new Error("Expected current receipt worker facts");
      }
      return result.facts;
    };
    try {
      const admitted = await read();
      expect(admitted.receipt).toEqual(handle);
      expect(admitted.deletionBlocked).toBe(false);
      expect(admitted.job).toMatchObject({
        id: job.id,
        agentId: "alpha",
        enabled: true,
        hasCanonicalDeliveryMode: true,
        configRevision: handle.configRevision,
        messageToolAuthorityInputs: { policy: job.scheduledToolPolicy },
        messageActionAuthorityInputs: {
          policy: job.scheduledToolPolicy,
          callerOrigin: { kind: "local" },
          executableRevision: expect.any(String),
        },
      });
      job.enabled = false;
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const disabled = await read();
      expect(disabled.receipt).toEqual(handle);
      expect(disabled.job?.enabled).toBe(false);
      expect(disabled.job?.configRevision).not.toBe(admitted.job?.configRevision);
      expect(disabled.job?.grantDefinitionRevision).toBe(admitted.job?.grantDefinitionRevision);
      expect(disabled.job?.messageToolAuthorityInputs).toEqual(
        admitted.job?.messageToolAuthorityInputs,
      );
      job.enabled = true;
      job.payload.message = "read another synthetic conversation";
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const edited = await read();
      expect(edited.receipt).toEqual(handle);
      expect(edited.job?.grantDefinitionRevision).not.toBe(admitted.job?.grantDefinitionRevision);
      expect(edited.job?.messageToolAuthorityInputs).toEqual(
        admitted.job?.messageToolAuthorityInputs,
      );
      expect(edited.job?.messageActionAuthorityInputs).not.toEqual(
        admitted.job?.messageActionAuthorityInputs,
      );
      expect((await read(handle.ownerPid + 1)).job).toBeUndefined();
    } finally {
      await finishCronRunReceiptAsync({ handle, status: "skipped", finishedAtMs: 3 });
    }
  });
});

it("rechecks unrepaired delivery in the current row before activating a prepared run", async () => {
  await withOpenClawTestState({ label: "cron-receipt-delivery" }, async (fixture) => {
    const job = makeCronReceiptJob("delivery-changed-after-claim");
    job.delivery = { mode: "announce", channel: "telegram", to: "synthetic-target" };
    const storePath = fixture.statePath("cron", "jobs.json");
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const handle = claimCronRunReceiptForTest(storePath, job, 1);
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const marker = markServiceCronJobActive(state, job, handle);
    const context = captureOpenClawStateReadWorkerContext();
    try {
      await expect(
        assertServiceCronRunReceiptCurrent(state, handle, marker, context),
      ).resolves.toBeUndefined();
      const db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.delivery.mode') WHERE store_key = ? AND job_id = ?",
      ).run(cronStoreKey(storePath), job.id);
      const before = db
        .prepare("SELECT job_json, state_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(storePath), job.id);
      await expect(
        assertServiceCronRunReceiptCurrent(state, handle, marker, context),
      ).rejects.toThrow("openclaw doctor --fix");
      expect(() =>
        runOpenClawStateWriteTransaction(({ db: transactionDb }) =>
          activateCronRunReceiptInDatabase({
            database: transactionDb,
            handle,
            startedAtMs: 2,
            resolveAgentId: (current) => current.agentId!,
          }),
        ),
      ).toThrow(CronRunReceiptRevisionError);
      expect(() =>
        runOpenClawStateWriteTransaction(({ db: transactionDb }) =>
          assertCronRunReceiptCurrentInDatabase({
            database: transactionDb,
            handle,
            resolveAgentId: (current) => current.agentId!,
          }),
        ),
      ).not.toThrow();
      expect(
        db
          .prepare("SELECT job_json, state_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(cronStoreKey(storePath), job.id),
      ).toEqual(before);
      expect(
        findActiveCronRunReceiptInDatabase({ database: db, storePath, jobId: job.id }),
      ).toMatchObject({ receiptId: handle.receiptId, startedAtMs: 1 });
    } finally {
      clearCronJobActive(job.id, marker);
      await finishCronRunReceiptAsync({ handle, status: "skipped", finishedAtMs: 3 });
    }
  });
});

it.each(["payload", "webhook"] as const)(
  "rejects the main-session %s effect when removal commits after its native receipt snapshot",
  async (phase) => {
    await withOpenClawTestState({ label: `cron-main-removal-${phase}` }, async (state) => {
      // The gate intercepts worker creation; path-scoped fixture cleanup retains the read pool.
      await closeOpenClawStateDatabaseAsync();
      const preload = state.path("receipt-reply-gate.mjs");
      await fs.writeFile(
        preload,
        `import { parentPort, workerData, isMainThread, threadId } from "node:worker_threads";
         const gate = new Int32Array(workerData.receiptGate);
         const post = parentPort.postMessage.bind(parentPort);
         parentPort.postMessage = (message, ...args) => {
           if (message?.status === "ok" && message.value?.ok &&
               message.value.type === "cron.currentReceipt" && Atomics.load(gate, 0) > 0) {
             const count = Atomics.add(gate, 1, 1) + 1;
             if (count === Atomics.load(gate, 0)) {
               workerData.receiptGatePort.postMessage({
                 isMainThread, threadId,
                 jobId: message.value.facts.receipt?.jobId,
                 jobPresent: message.value.facts.job !== undefined,
               });
               Atomics.wait(gate, 2, 0);
             }
           }
           return post(message, ...args);
         };`,
      );
      const gate = new Int32Array(new SharedArrayBuffer(12));
      const { port1, port2 } = new MessageChannel();
      const entered = createDeferred<unknown>();
      port1.once("message", (message: unknown) => entered.resolve(message));
      const readUrl = resolveRuntimeProcessEntrypointUrl("stateRead").href;
      let selected = false;
      const create = nativeWorkers.createRetainedNativeWorker;
      const factory = vi
        .spyOn(nativeWorkers, "createRetainedNativeWorker")
        .mockImplementation((filename, options, source, resource) => {
          if (selected || String(filename) !== readUrl) {
            return create(filename, options, source, resource);
          }
          selected = true;
          const nativeOptions = options ?? {};
          const workerData = isRecord(nativeOptions.workerData) ? nativeOptions.workerData : {};
          return create(
            filename,
            {
              ...nativeOptions,
              execArgv: [
                ...(nativeOptions.execArgv ?? []),
                "--import",
                pathToFileURL(preload).href,
              ],
              workerData: { ...workerData, receiptGate: gate.buffer, receiptGatePort: port2 },
              transferList: [...(nativeOptions.transferList ?? []), port2],
            },
            source,
            resource,
          );
        });
      const runSessionEvent = vi.fn(async () => {
        if (phase === "webhook") {
          Atomics.store(gate, 0, 1);
        }
        return { status: "ok" as const, summary: "Synthetic main-session result" };
      });
      const sendCronWebhook = vi.fn(async () => ({ status: "delivered" as const }));
      const storePath = state.statePath("cron", "jobs.json");
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        sendCronWebhook,
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      let run: ReturnType<CronService["run"]> | undefined;
      try {
        await cron.start();
        const job = await cron.add({
          name: "main-session removal during receipt read",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "synthetic main-session event" },
          ...(phase === "webhook"
            ? { delivery: { mode: "webhook" as const, to: "https://example.invalid/hook" } }
            : {}),
        });
        Atomics.store(gate, 0, phase === "payload" ? 1 : 0);
        run = cron.run(job.id, "force");
        expect(
          await Promise.race([
            entered.promise,
            run.then(() => {
              throw new Error("Cron completed without the selected native receipt reply");
            }),
          ]),
        ).toEqual({
          isMainThread: false,
          threadId: expect.any(Number),
          jobId: job.id,
          jobPresent: true,
        });
        expect(runSessionEvent).toHaveBeenCalledTimes(phase === "webhook" ? 1 : 0);
        expect(sendCronWebhook).not.toHaveBeenCalled();
        await expect(cron.remove(job.id)).resolves.toEqual({
          ok: true,
          removed: true,
          activeRunCancellationRequested: true,
        });
        expect(
          openOpenClawStateDatabase()
            .db.prepare("SELECT job_id FROM cron_jobs WHERE store_key = ? AND job_id = ?")
            .get(cronStoreKey(storePath), job.id),
        ).toBeUndefined();
        Atomics.store(gate, 2, 1);
        Atomics.notify(gate, 2);
        await expect(run).resolves.toMatchObject({ ok: true, ran: true });
        expect(runSessionEvent).toHaveBeenCalledTimes(phase === "webhook" ? 1 : 0);
        expect(sendCronWebhook).not.toHaveBeenCalled();
      } finally {
        Atomics.store(gate, 2, 1);
        Atomics.notify(gate, 2);
        cron.stop();
        await run?.catch(() => undefined);
        await closeOpenClawStateDatabaseAsync();
        factory.mockRestore();
        port1.close();
        port2.close();
      }
    });
  },
);
