import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { CronService } from "../../cron/service.js";
import { GatewayConnectionWork } from "../../gateway/server-connection-work.js";
import { drainGatewayCron } from "../../gateway/server-cron-drain.js";
import { runGatewayCloseSteps } from "../../gateway/server-shutdown.js";
import { writeGatewayRestartIntentSync } from "../../infra/restart-intent.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { runGatewayLoop } from "./run-loop.js";

const root = process.argv[2]!;
const force = process.argv[3] === "force";
const trace = (message: string) => process.stdout.write(`process proof: ${message}\n`);
const connectionWork = new GatewayConnectionWork();
const coreStarted = createDeferredCore();
const cleanupMayFinish = createDeferredCore();
let starts = 0;
process.on("message", (message) => {
  if (message === "inspect") {
    trace(`held:starts=${starts}:pending=${connectionWork.hasPendingWork}`);
  } else if (message === "release") {
    cleanupMayFinish.resolve();
  }
});
const cron = new CronService({
  scheduler: createTestGatewayScheduler(),
  nowMs: () => Date.now(),
  storePath: path.join(root, "state", "cron", "jobs.json"),
  cronEnabled: false,
  defaultAgentId: "main",
  log: { info() {}, warn() {}, error() {}, debug() {} },
  enqueueSystemEvent() {},
  requestHeartbeat() {},
  runIsolatedAgentJob: ({ abortSignal, onExecutionStarted }) =>
    trackAsyncWork(async () => {
      assert(abortSignal);
      const cancelled = createDeferredCore();
      abortSignal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      onExecutionStarted?.();
      coreStarted.resolve();
      trace("cron-started");
      if (!force) {
        await cancelled.promise;
        trace(`cron-cancelled:${String(abortSignal.reason)}`);
      }
      await cleanupMayFinish.promise;
      if (force) {
        assert(!abortSignal.aborted, "force restart cancelled admitted work before its budget");
      }
      await fs.writeFile(path.join(root, "cleanup.txt"), "settled\n");
      trace("cron-cleanup-settled");
      return { status: "ok" as const, summary: "settled" };
    }),
});

await runGatewayLoop({
  ownsProcessLifecycle: true,
  start: async () => {
    starts += 1;
    if (starts === 1) {
      const job = await cron.add({
        agentId: "main",
        name: "forced-restart-cron",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() + 600_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "Synthetic pending work" },
        delivery: { mode: "none" },
      });
      const accepted = await connectionWork.track(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () => cron.enqueueRun(job.id, "force"),
          "rpc:cron.run",
        ),
      );
      assert(accepted.ok && "enqueued" in accepted && accepted.enqueued);
      await coreStarted.promise;
      assert(
        writeGatewayRestartIntentSync({
          targetPid: process.pid,
          intent: force ? { force: true } : { waitMs: 1 },
        }),
      );
    }
    setImmediate(() => trace(`ready:${starts}`));
    return {
      getTailscaleIngressEndpoint: () => undefined,
      startupSettled: Promise.resolve(),
      close: async () => {
        trace("close-entered");
        await runGatewayCloseSteps({
          owner: {
            connectionWork,
            stopConnectionDependentSidecars() {},
            stopRegisteredGatewayLifetimeSidecars() {},
            stopRegisteredPostReadySidecars() {},
            runClosePrelude() {},
            sealAndJoinRegisteredSidecarStops() {},
          },
          close: async () => {
            cron.stop();
            await drainGatewayCron({
              exitWatchersStop: Promise.resolve(),
              streamWatchersStop: Promise.resolve(),
              logger: { warn: (...args) => assert.fail(JSON.stringify(args)) },
            });
            trace("close-completed");
          },
          onError: (message) => {
            throw new Error(message);
          },
        });
      },
    };
  },
  runtime: {
    log() {},
    error: console.error,
    exit: (code) => {
      trace(`exit:${code}`);
      process.exit(code);
    },
  },
});
