import { once } from "node:events";
import { deserialize } from "node:v8";
import { MessageChannel, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { startSqliteConcurrentWriter } from "../../infra/sqlite-concurrent-writer.test-support.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { CronService } from "../service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import {
  inspectActiveCronRunReceipt,
  makeCronRecoveryJob,
} from "../store/run-receipt-store.test-support.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import { createCronRecoveryFixture } from "./run-recovery.test-support.js";
import * as serviceState from "./state.js";
import { onTimer } from "./timer.test-support.js";

const suite = setupCronServiceSuite({ prefix: "cron-recovery-admission-" });
const { logger } = suite;

describe("", () => {
  const fixtures = createCronRecoveryFixture(suite, onTestFinished);
  afterEach(() => fixtures.finishAfterEach());
  it("lists behind healthy recovery while a writer is held, and retires a waiting repair", async () =>
    fixtures.run(async (fixture) => {
      const { storePath } = await fixture.makeStorePath();
      const nowMs = Date.now();
      const jobs = Array.from({ length: 66 }, (_, index) => {
        const job = makeCronRecoveryJob(`job-${index}`, nowMs - 100);
        delete job.state.runningAtMs;
        job.enabled = index < 64;
        job.state.nextRunAtMs = nowMs + 86_400_000;
        return job;
      });
      await writeCronStoreSnapshot({ storePath, jobs });
      let state: serviceState.CronServiceState | undefined;
      const createState = serviceState.createCronServiceState;
      const capture = vi
        .spyOn(serviceState, "createCronServiceState")
        .mockImplementation((deps) => {
          state = createState(deps);
          return state;
        });
      const onEvent = vi.fn();
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const cron = new CronService({
        storePath,
        cronEnabled: true,
        defaultAgentId: "alpha",
        isAgentAvailable: () => true,
        nowMs: () => nowMs,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: runner,
        runCommandJob: runner,
        onEvent,
      });
      capture.mockRestore();
      if (!state) {
        throw new Error("Expected the service state");
      }
      const scheduler = fixture.state(state);
      const receipts: CronRunReceiptHandle[] = [];
      let writer: ReturnType<typeof startSqliteConcurrentWriter> | undefined;
      let pending: Promise<void> | undefined;
      let stoppedWriter: Promise<void> | undefined;
      const stopWriter = () =>
        writer ? (stoppedWriter ??= fixture.track(writer.stop())) : undefined;
      let watchdogReleased = false;
      let watchdog: AbortSignal | undefined;
      const releaseStuckWriter = () => {
        watchdogReleased = true;
        void stopWriter();
      };
      const posted = createDeferred();
      // oxlint-disable-next-line typescript/unbound-method -- call retains the observed Worker receiver.
      const nativePost = Worker.prototype.postMessage;
      const observe = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request: SqliteWorkerRequest,
        transferList,
      ) {
        if (request.type === "execute") {
          const command: unknown = deserialize(request.input);
          if (isRecord(command) && command.type === "cron.repairRun") {
            posted.resolve();
          }
        }
        return nativePost.call(this, request, transferList);
      });
      fixture.release(() => {
        watchdog?.removeEventListener("abort", releaseStuckWriter);
        cron.stop();
        return stopWriter();
      });
      fixture.cleanup(async () => {
        await Promise.allSettled([pending]);
        observe.mockRestore();
        for (const receipt of receipts) releaseLocalCronRunReceiptOwnership(receipt);
        openOpenClawStateDatabase().db.exec("DROP TABLE IF EXISTS writes");
      });

      await fixture.track(cron.start());
      for (const job of jobs.slice(0, 16)) {
        const startedAtMs = nowMs - 100;
        const prepared = prepareCronRunReceiptClaim({
          storePath,
          job,
          agentId: "alpha",
          startedAtMs,
        });
        const receipt = runOpenClawStateWriteTransaction(({ db }) =>
          claimCronRunReceiptInDatabase({ database: db, prepared, resolveAgentId: () => "alpha" }),
        );
        receipts.push(receipt);
        job.state.runningAtMs = startedAtMs;
        job.state.runningReceiptId = receipt.receiptId;
      }
      await writeCronStoreSnapshot({ storePath, jobs });
      const baseline = await cron.listPage({ limit: 50 });
      const database = openOpenClawStateDatabase();
      database.db.exec("CREATE TABLE writes (id INTEGER PRIMARY KEY)");
      fixture.assertCurrent();
      writer = startSqliteConcurrentWriter(database.path, "WAL");
      await writer.waitFor("ready");
      expect(await writer.holdTransaction()).toMatchObject({ transaction: true });
      // Cleanup only: a regressed blocking read must not strand the independent writer.
      watchdog = AbortSignal.timeout(15_000);
      watchdog.addEventListener("abort", releaseStuckWriter, { once: true });
      pending = fixture.track(onTimer(scheduler));
      const pages = await Promise.all([cron.listPage({ limit: 50 }), cron.listPage({ limit: 50 })]);
      await pending;
      expect(watchdogReleased).toBe(false);
      expect(pages).toEqual([baseline, baseline]);
      expect(baseline.total).toBe(64);
      expect(baseline.jobs).toHaveLength(50);

      releaseLocalCronRunReceiptOwnership(receipts[0]!);
      let settled = false;
      pending = fixture.track(
        fixture.track(onTimer(scheduler)).finally(() => {
          settled = true;
        }),
      );
      await fixture.waitFor(posted.promise, pending);
      const { port1, port2 } = new MessageChannel();
      try {
        const heartbeat = fixture.track(once(port1, "message", { signal: fixture.signal }));
        port2.postMessage("heartbeat");
        expect(await heartbeat).toEqual(["heartbeat"]);
      } finally {
        port1.close();
        port2.close();
      }
      expect(settled).toBe(false);
      cron.stop();
      await stopWriter();
      await pending;
      expect(inspectActiveCronRunReceipt({ storePath, jobId: jobs[0]!.id })).toMatchObject({
        receiptId: receipts[0]!.receiptId,
      });
      expect((await loadCronStore(storePath)).jobs[0]?.state.runningAtMs).toBe(nowMs - 100);
      expect(onEvent.mock.calls.filter(([event]) => event.action === "finished")).toEqual([]);
      expect(runner).not.toHaveBeenCalled();
      expect(scheduler.activeTimerTicks).toBe(0);
    }));
});
