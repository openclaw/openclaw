import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import { dispatchCronDelivery } from "./isolated-agent/delivery-dispatch.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { waitForActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import type { CronEvent } from "./service/state.js";

const FOUR_HOURS_MS = 4 * 60 * 60_000;

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
        enqueueSessionEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        runScriptJob,
        onEvent: (event) => {
          if (event.action === "started") {
            // Preflight recovery reads hold the mutation lock; gate the active payload's read.
            Atomics.store(gate, 0, 1);
          }
        },
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
            enqueueSessionEvent: vi.fn(),
            onEvent: (event) => {
              events.push(event);
              if (event.action === "finished") {
                finished.resolve(event);
              }
            },
            runIsolatedAgentJob: async ({ job, abortSignal, deliveryAttemptFence }) => {
              const text = "Fresh result from this invocation.";
              const sessionKey = `agent:main:cron:${job.id}`;
              const deliveryPlan = resolveCronDeliveryPlan(job);
              const resolvedDelivery = await resolveDeliveryTarget(cfg, "main", {
                ...job,
                ...deliveryPlan,
              });
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
                resolvedDelivery,
                deliveryRequested: true,
                deliveryPlan,
                undeliveredRunStatus: "ok",
                spawnOnlyHandoff: false,
                sourceDeliveryOutcome: {
                  visibleDeliveries: [],
                  verifiedMessageToolDelivery: false,
                  satisfiesSourceDelivery: false,
                  unverifiedMessageToolDelivery: false,
                },
                deliveryBestEffort: false,
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
