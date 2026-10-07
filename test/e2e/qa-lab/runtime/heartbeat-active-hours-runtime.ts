// The ordinary scheduler naturally executes each persisted active-hours phase.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CronService } from "../../../../src/cron/service.js";
import type { CronEvent } from "../../../../src/cron/service/state.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import {
  GatewayScheduler,
  type GatewaySchedulerClock,
} from "../../../../src/infra/gateway-scheduler.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

type HeartbeatRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
  clock?: GatewaySchedulerClock;
  advanceClock?: (atMs: number) => void | Promise<void>;
};

type SchedulerObservation = {
  at: string;
  outcome: "active-fire" | "quiet-hours-skip";
  scheduledAtMs: number;
  runAtMs: number;
};

function parseOptions(argv: string[], repoRoot = process.cwd()): HeartbeatRuntimeOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "heartbeat-active-hours");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      artifactBase = path.resolve(repoRoot, argv[++index] ?? "");
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { artifactBase, repoRoot };
}

function createWriter(options: HeartbeatRuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "heartbeat-active-hours.log",
    primaryModel: "cron/scheduler",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: "heartbeat-active-hours",
      title: "Ordinary automation active-hours policy",
      sourcePath: "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
      docsRefs: ["docs/automation/cron-jobs.md"],
      codeRefs: [
        "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
        "src/cron/service/timer-execution.ts",
        "src/cron/active-hours.ts",
      ],
    },
  });
}

export async function runHeartbeatActiveHoursRuntime(options: HeartbeatRuntimeOptions) {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "automation-active-hours-" },
    async (state) => await runActiveHoursPhases(options, state.statePath("cron", "jobs.json")),
  );
}

async function runActiveHoursPhases(options: HeartbeatRuntimeOptions, storePath: string) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  const observations: SchedulerObservation[] = [];
  const scheduler = new GatewayScheduler({ clock: options.clock });
  let executionCount = 0;
  let expectedJobId: string | undefined;
  let onFinished: ((event: CronEvent) => void) | undefined;
  const log = (entry: unknown, message?: string) => {
    writer.appendLog(`${message ?? JSON.stringify(entry)}\n`);
  };
  const cron = new CronService({
    storePath,
    scheduler,
    cronEnabled: true,
    log: { debug: log, info: log, warn: log, error: log },
    enqueueSystemEvent: () => {
      throw new Error("Active-hours evidence must use ordinary session execution");
    },
    runIsolatedAgentJob: async () => {
      throw new Error("Active-hours evidence must use its original session");
    },
    runSessionEvent: async () => {
      executionCount += 1;
      return { status: "ok", executionStarted: true };
    },
    onEvent: (event) => {
      if (event.jobId === expectedJobId && event.action === "finished") {
        onFinished?.(event);
      }
    },
  });
  try {
    const job = await cron.add({
      name: "Active-hours evidence",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      activeHours: { start: "00:00", end: "24:00", timezone: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Check the active-hours policy" },
    });
    expectedJobId = job.id;
    await cron.start();
    for (const quiet of [false, true, false]) {
      const scheduledAtMs = scheduler.now() + 1000;
      const before = executionCount;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = new Promise<CronEvent>((resolve, reject) => {
        onFinished = resolve;
        timer = setTimeout(() => reject(new Error("Scheduled automation did not settle")), 30_000);
      });
      try {
        await cron.update(job.id, {
          enabled: true,
          deleteAfterRun: false,
          schedule: { kind: "at", at: new Date(scheduledAtMs).toISOString() },
          activeHours: { start: "00:00", end: quiet ? "00:00" : "24:00", timezone: "UTC" },
        });
        await options.advanceClock?.(scheduledAtMs);
        const event = await settled;
        if (
          event.status !== (quiet ? "skipped" : "ok") ||
          !event.runAtMs ||
          event.runAtMs < scheduledAtMs
        ) {
          throw new Error(`Unexpected scheduled active-hours outcome: ${JSON.stringify(event)}`);
        }
        if (executionCount !== before + (quiet ? 0 : 1)) {
          throw new Error("Active-hours admission started the wrong number of session turns");
        }
        const outcome = quiet ? "quiet-hours-skip" : "active-fire";
        observations.push({
          at: new Date().toISOString(),
          outcome,
          scheduledAtMs,
          runAtMs: event.runAtMs,
        });
        writer.appendLog(`${outcome}: scheduled=${scheduledAtMs}, started=${event.runAtMs}\n`);
      } finally {
        clearTimeout(timer);
        onFinished = undefined;
      }
    }

    const summaryPath = path.join(options.artifactBase, "heartbeat-active-hours-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify({ observations }, null, 2)}\n`, "utf8");
    return await writer.write({
      artifacts: [{ kind: "summary", filePath: summaryPath }],
      details: "Observed active fire, quiet-hours skip, and active-hours reload fire",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`heartbeat-active-hours: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    cron.stop();
    await cron.waitForIdle();
    await scheduler.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runHeartbeatActiveHoursRuntime(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      const status = evidence.entries[0]?.result.status;
      process.stdout.write(`heartbeat-active-hours: ${status}\n`);
      process.exitCode = status === "pass" ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`heartbeat-active-hours: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
