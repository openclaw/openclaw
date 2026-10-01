import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import * as nativeWorkers from "../infra/worker-native-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { cronStoreKey } from "./store/key.js";

it.each(["payload", "webhook"] as const)(
  "rejects the main-session %s effect when removal commits after its native receipt snapshot",
  async (phase) => {
    await withOpenClawTestState({ label: `cron-main-removal-${phase}` }, async (state) => {
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
      const enqueueSystemEvent = vi.fn();
      const requestHeartbeat = vi.fn();
      const sendCronWebhook = vi.fn(async () => ({ status: "delivered" as const }));
      const storePath = state.statePath("cron", "jobs.json");
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent,
        requestHeartbeat,
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
        Atomics.store(gate, 0, phase === "webhook" ? 2 : 1);
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
        expect(enqueueSystemEvent).toHaveBeenCalledTimes(phase === "webhook" ? 1 : 0);
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
        expect(enqueueSystemEvent).toHaveBeenCalledTimes(phase === "webhook" ? 1 : 0);
        expect(requestHeartbeat).toHaveBeenCalledTimes(phase === "webhook" ? 1 : 0);
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
