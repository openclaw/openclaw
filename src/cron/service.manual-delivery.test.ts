import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MessageChannel } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import * as nativeWorkers from "../infra/worker-native-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { dispatchCronDelivery } from "./isolated-agent/delivery-dispatch.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { waitForActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import type { CronEvent } from "./service/state.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

const FOUR_HOURS_MS = 4 * 60 * 60_000;
const execFileAsync = promisify(execFile);

describe("manual cron delivery occurrence", () => {
  it("keeps the event loop live and joins a cancelled native receipt read before payload dispatch", async () => {
    await withOpenClawTestState({ label: "cron-held-receipt" }, async (state) => {
      const preload = state.path("receipt-read-gate.mjs");
      await fs.writeFile(
        preload,
        `import { DatabaseSync } from "node:sqlite";
         import { workerData, isMainThread, threadId } from "node:worker_threads";
         const gate = new Int32Array(workerData.receiptGate);
         const prepare = DatabaseSync.prototype.prepare;
         DatabaseSync.prototype.prepare = function (sql, ...args) {
           if (Atomics.load(gate, 0) === 1 && sql.includes('from "cron_run_receipts"')) {
             Atomics.store(gate, 0, 2);
             workerData.receiptGatePort.postMessage({ isMainThread, threadId });
             Atomics.wait(gate, 1, 0);
           }
           return prepare.call(this, sql, ...args);
         };`,
      );
      const gate = new Int32Array(new SharedArrayBuffer(8));
      const { port1, port2 } = new MessageChannel();
      const entered = createDeferred<unknown>();
      port1.once("message", (message: unknown) => entered.resolve(message));
      const readUrl = resolveRuntimeProcessEntrypointUrl("stateRead").href;
      let selected = false;
      let exited = false;
      const create = nativeWorkers.createRetainedNativeWorker;
      const factory = vi
        .spyOn(nativeWorkers, "createRetainedNativeWorker")
        .mockImplementation((filename, options, source, resource, taskPorts) => {
          if (selected || String(filename) !== readUrl) {
            return create(filename, options, source, resource, taskPorts);
          }
          selected = true;
          const nativeOptions = options ?? {};
          const workerData = isRecord(nativeOptions.workerData) ? nativeOptions.workerData : {};
          const worker = create(
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
            taskPorts,
          );
          worker.once("exit", () => {
            exited = true;
          });
          return worker;
        });
      const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath: state.statePath("cron", "jobs.json"),
        cronEnabled: false,
        defaultAgentId: "main",
        cronConfig: { triggers: { enabled: true } },
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runScriptJob,
      });
      let run: ReturnType<CronService["run"]> | undefined;
      try {
        await cron.start();
        const job = await cron.add({
          name: "held receipt read",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "script", script: "return {}" },
        });
        Atomics.store(gate, 0, 1);
        run = cron.run(job.id, "force");
        expect(
          await Promise.race([
            entered.promise,
            run.then(() => {
              throw new Error("Cron completed without entering the native receipt query");
            }),
          ]),
        ).toEqual({ isMainThread: false, threadId: expect.any(Number) });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(Atomics.load(gate, 0)).toBe(2);
        expect(runScriptJob).not.toHaveBeenCalled();
        await expect(cron.remove(job.id)).resolves.toEqual({
          ok: true,
          removed: true,
          activeRunCancellationRequested: true,
        });
        await expect(waitForActiveCronTaskRuns(10_000)).resolves.toEqual({
          drained: true,
          active: 0,
        });
        await run;
        expect(exited).toBe(true);
        expect(runScriptJob).not.toHaveBeenCalled();
      } finally {
        Atomics.store(gate, 1, 1);
        Atomics.notify(gate, 1);
        cron.stop();
        await run?.catch(() => undefined);
        factory.mockRestore();
        port1.close();
        port2.close();
      }
    });
  });

  it.each(["trigger", "script", "webhook"] as const)(
    "refuses the %s effect after a foreign receipt commit despite an inherited discovery snapshot",
    async (phase) => {
      await withOpenClawTestState({ label: "cron-current-receipt" }, async (state) => {
        const storePath = state.statePath("cron", "jobs.json");
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        let now = Date.now();
        const retireReceipt = vi.fn(async (job: CronJob) => {
          const { stdout } = await execFileAsync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `import { DatabaseSync } from "node:sqlite";
               const db = new DatabaseSync(process.argv[1]);
               try {
                 const result = db.prepare("UPDATE cron_run_receipts SET status = 'superseded', finished_at_ms = ?, error_text = 'foreign receipt retirement' WHERE store_key = ? AND job_id = ? AND status = 'running'").run(Number(process.argv[4]), process.argv[2], process.argv[3]);
                 process.stdout.write(JSON.stringify({ changes: result.changes, pid: process.pid }));
               } finally { db.close(); }`,
              databasePath,
              cronStoreKey(storePath),
              job.id,
              String(now),
            ],
            { env: {} },
          );
          const result: unknown = JSON.parse(stdout);
          expect(result).toEqual({ changes: 1, pid: expect.any(Number) });
          expect(result).not.toMatchObject({ pid: process.pid });
        });
        const evaluateCronTrigger = vi.fn(async ({ job }: { job: CronJob }) => {
          await retireReceipt(job);
          return { kind: "evaluated" as const, fire: true };
        });
        const runScriptJob = vi.fn(async ({ job }: { job: CronJob }) => {
          await retireReceipt(job);
          return { status: "ok" as const, notify: "must not enqueue", wake: "now" as const };
        });
        const runIsolatedAgentJob = vi.fn(async ({ job }: { job: CronJob }) => {
          await retireReceipt(job);
          return { status: "ok" as const, summary: "must not send" };
        });
        const enqueueSystemEvent = vi.fn();
        const requestHeartbeat = vi.fn();
        const sendCronWebhook = vi.fn(async () => ({ status: "delivered" as const }));
        const cron = new CronService({
          scheduler: createTestGatewayScheduler(),
          storePath,
          cronEnabled: false,
          defaultAgentId: "main",
          nowMs: () => now,
          cronConfig: { triggers: { enabled: true } },
          log: createNoopLogger(),
          evaluateCronTrigger,
          runScriptJob,
          runIsolatedAgentJob,
          enqueueSystemEvent,
          requestHeartbeat,
          sendCronWebhook,
        });
        try {
          await cron.start();
          const job = await cron.add({
            name: "current receipt before effect",
            agentId: "main",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: phase === "webhook" ? "isolated" : "main",
            wakeMode: "now",
            payload:
              phase === "script"
                ? { kind: "script", script: "return { notify: 'must not enqueue' }" }
                : phase === "webhook"
                  ? { kind: "agentTurn", message: "produce a result" }
                  : { kind: "systemEvent", text: "must not enqueue" },
            ...(phase === "trigger" ? { trigger: { script: "return { fire: true }" } } : {}),
            ...(phase === "webhook"
              ? { delivery: { mode: "webhook", to: "https://example.invalid/hook" } }
              : {}),
          });
          if (job.state.nextRunAtMs === undefined) {
            throw new Error("Receipt fixture has no scheduled occurrence");
          }
          now = job.state.nextRunAtMs;
          await withOpenClawStateDatabaseReadSnapshot(
            async () => {
              await expect(cron.run(job.id, "due")).resolves.toMatchObject({
                ok: true,
                ran: true,
              });
            },
            { path: databasePath, env: state.env },
          );
          expect(retireReceipt).toHaveBeenCalledOnce();
          expect(evaluateCronTrigger).toHaveBeenCalledTimes(phase === "trigger" ? 1 : 0);
          expect(runScriptJob).toHaveBeenCalledTimes(phase === "script" ? 1 : 0);
          expect(runIsolatedAgentJob).toHaveBeenCalledTimes(phase === "webhook" ? 1 : 0);
          expect(enqueueSystemEvent).not.toHaveBeenCalled();
          expect(requestHeartbeat).not.toHaveBeenCalled();
          expect(sendCronWebhook).not.toHaveBeenCalled();
          expect(
            openOpenClawStateDatabase()
              .db.prepare("SELECT status, error_text FROM cron_run_receipts WHERE job_id = ?")
              .all(job.id),
          ).toEqual([{ status: "superseded", error_text: "foreign receipt retirement" }]);
        } finally {
          cron.stop();
        }
      });
    },
  );

  it.each([
    { label: "queued force", mode: "force", queued: true },
    { label: "scheduled due", mode: "due", queued: false },
  ] as const)(
    "delivers according to the $label occurrence after the scheduled slot ages",
    async ({ mode, queued }) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-manual-delivery-" },
        async (state) => {
          const registry = captureActivePluginRegistrySnapshot();
          const sendText = vi.fn(async () => ({ channel: "telegram", messageId: "fresh-result" }));
          setActivePluginRegistry(
            createTestRegistry([
              {
                pluginId: "telegram",
                source: "test",
                plugin: createOutboundTestPlugin({
                  id: "telegram",
                  outbound: { deliveryMode: "direct", sendText },
                }),
              },
            ]),
          );
          let now = Date.now() - FOUR_HOURS_MS;
          const cfg: OpenClawConfig = {
            agents: { entries: { main: { workspace: state.workspaceDir } } },
          };
          await state.writeConfig(cfg);
          const events: CronEvent[] = [];
          const finished = createDeferred<CronEvent>();
          const cron = new CronService({
            scheduler: createTestGatewayScheduler(),
            storePath: state.path("cron", "jobs.json"),
            cronEnabled: false,
            defaultAgentId: "main",
            nowMs: () => now,
            log: createNoopLogger(),
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            onEvent: (event) => {
              events.push(event);
              if (event.action === "finished") {
                finished.resolve(event);
              }
            },
            runIsolatedAgentJob: async ({ job, abortSignal, deliveryAttemptFence }) => {
              const text = "Fresh result from this invocation.";
              const sessionKey = `agent:main:cron:${job.id}`;
              const delivery = await dispatchCronDelivery({
                cfgWithAgentDefaults: cfg,
                deps: {},
                job,
                deliveryAttemptFence,
                agentId: "main",
                agentSessionKey: sessionKey,
                runSessionKey: sessionKey,
                sessionId: "manual-delivery-run",
                lifecycleRevision: "manual-delivery-revision",
                sessionUpdatedAt: now,
                runStartedAt: now,
                timeoutMs: 30_000,
                resolvedDelivery: { ok: true, channel: "telegram", to: "123", mode: "explicit" },
                deliveryRequested: true,
                deliveryPlan: resolveCronDeliveryPlan(job),
                undeliveredRunStatus: "ok",
                spawnOnlyHandoff: false,
                sourceDeliveryOutcome: {
                  visibleDeliveries: [],
                  verifiedMessageToolDelivery: false,
                  satisfiesSourceDelivery: false,
                  unverifiedMessageToolDelivery: false,
                },
                deliveryBestEffort: false,
                deliveryPayloadHasStructuredContent: false,
                deliveryPayloads: [{ text }],
                synthesizedText: text,
                summary: text,
                outputText: text,
                abortSignal,
                isAborted: () => abortSignal?.aborted === true,
                abortReason: () => "aborted",
              });
              const failure =
                delivery.disposition?.kind === "error" ? delivery.disposition : undefined;
              return {
                ...delivery,
                status: failure ? "error" : "ok",
                error: failure?.error,
                errorKind: failure?.errorKind,
              };
            },
          });
          try {
            await cron.start();
            const job = await cron.add({
              name: "fresh manual result",
              enabled: true,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Produce a fresh report." },
              delivery: { mode: "announce", channel: "telegram", to: "123" },
            });
            const scheduledAt = job.state.nextRunAtMs;
            now += FOUR_HOURS_MS;
            if (queued) {
              await expect(cron.enqueueRun(job.id, mode)).resolves.toMatchObject({
                ok: true,
                enqueued: true,
              });
              expect(await finished.promise).toMatchObject({ jobId: job.id });
              await cron.status();
            } else {
              await expect(cron.run(job.id, mode)).resolves.toMatchObject({ ok: true, ran: true });
            }
            expect(sendText).toHaveBeenCalledTimes(mode === "force" ? 1 : 0);
            expect(events.find((event) => event.action === "finished")).toMatchObject({
              status: "ok",
              completionStatus: mode === "force" ? "succeeded" : "failed",
              deliveryStatus: mode === "force" ? "delivered" : "not-delivered",
            });
            if (mode === "force") {
              expect(sendText).toHaveBeenCalledWith(
                expect.objectContaining({ text: "Fresh result from this invocation." }),
              );
              expect(cron.getJob(job.id)?.state.nextRunAtMs).toBe(scheduledAt);
              expect(cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();
            }
          } finally {
            cron.stop();
            restoreActivePluginRegistrySnapshot(registry);
          }
        },
      );
    },
  );
});
