// Retained QA entrypoint proves migrated active hours through the ordinary scheduler.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { CronService, type CronEvent } from "../../../../src/cron/service.js";
import { loadCronJobsStore } from "../../../../src/cron/store.js";
import { racePromiseWithAbortSignal } from "../../../../src/infra/abort-signal.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { GatewayScheduler } from "../../../../src/infra/gateway-scheduler.js";
import { createGatewaySchedulerClock } from "../../../../src/test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const AUTOMATION_INTERVAL_MS = 60_000;

type HeartbeatRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
  timeoutMs: number;
};

type SchedulerObservation = {
  at: string;
  outcome: "active-fire" | "quiet-hours-skip";
  executions: number;
  nextRunAtMs: number;
};

function parseOptions(argv: string[], repoRoot = process.cwd()): HeartbeatRuntimeOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "heartbeat-active-hours");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      artifactBase = path.resolve(repoRoot, argv[++index] ?? "");
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  return { artifactBase, repoRoot, timeoutMs };
}

function activeHours(quietHours: boolean) {
  return {
    start: "00:00",
    end: quietHours ? "00:00" : "24:00",
    timezone: "UTC",
  };
}

function createWriter(options: HeartbeatRuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "heartbeat-active-hours.log",
    primaryModel: "automations/scheduler",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: "heartbeat-active-hours",
      title: "Migrated heartbeat active-hours scheduler",
      sourcePath: "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
      docsRefs: ["docs/gateway/heartbeat.md"],
      codeRefs: [
        "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
        "src/cron/service/timer-scheduler.ts",
        "src/cron/service/timer-execution.ts",
        "src/cron/active-hours.ts",
      ],
    },
  });
}

export async function runHeartbeatActiveHoursRuntime(options: HeartbeatRuntimeOptions) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  const phaseObservations: SchedulerObservation[] = [];
  try {
    await withOpenClawTestState({ label: "automation-active-hours" }, async (state) => {
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      };
      await state.writeConfig(config);
      const clock = createGatewaySchedulerClock(Date.now());
      const scheduler = new GatewayScheduler({ clock: clock.clock });
      const storePath = state.statePath("cron", "jobs.json");
      const finished: CronEvent[] = [];
      let executions = 0;
      const cron = new CronService({
        scheduler,
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        log: {
          debug() {},
          info() {},
          warn: (_details, message) => writer.appendLog(`${message}\n`),
          error: (_details, message) => writer.appendLog(`${message}\n`),
        },
        enqueueSystemEvent() {},
        runIsolatedAgentJob: async () => {
          throw new Error("Expected ordinary shared-session automation");
        },
        runSessionEvent: async () => {
          executions += 1;
          return { status: "ok", executionStarted: true, summary: "Scheduled check completed" };
        },
        onEvent: (event) => {
          if (event.action === "finished") {
            finished.push(event);
          }
        },
      });
      try {
        const job = await cron.add({
          name: "Migrated active-hours check",
          agentId: "main",
          enabled: true,
          schedule: { kind: "every", everyMs: AUTOMATION_INTERVAL_MS },
          activeHours: activeHours(false),
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Perform the scheduled check" },
          delivery: { mode: "none" },
        });
        await cron.start();
        const fireNext = async (outcome: SchedulerObservation["outcome"]) => {
          const dueAtMs = cron.getJob(job.id)?.state.nextRunAtMs;
          if (typeof dueAtMs !== "number" || dueAtMs <= scheduler.now()) {
            throw new Error("Automation did not retain its next scheduled occurrence");
          }
          const beforeCount = finished.length;
          const beforeExecutions = executions;
          await racePromiseWithAbortSignal(
            Promise.resolve(clock.advanceTo(dueAtMs)),
            AbortSignal.timeout(options.timeoutMs),
          );
          const events = finished.slice(beforeCount);
          const expectedStatus = outcome === "active-fire" ? "ok" : "skipped";
          const expectedExecutions = beforeExecutions + (outcome === "active-fire" ? 1 : 0);
          const persisted = (await loadCronJobsStore(storePath)).jobs.find(
            (candidate) => candidate.id === job.id,
          );
          const nextRunAtMs = persisted?.state.nextRunAtMs;
          if (
            events.length !== 1 ||
            events[0]?.status !== expectedStatus ||
            executions !== expectedExecutions ||
            persisted?.state.lastRunStatus !== expectedStatus ||
            typeof nextRunAtMs !== "number" ||
            nextRunAtMs <= dueAtMs ||
            (outcome === "quiet-hours-skip" &&
              events[0]?.summary !== "Outside this automation's active hours")
          ) {
            throw new Error(
              `Scheduled ${outcome} failed: ${JSON.stringify({ events, executions, state: persisted?.state })}`,
            );
          }
          const observation = {
            at: new Date(scheduler.now()).toISOString(),
            outcome,
            executions,
            nextRunAtMs,
          };
          phaseObservations.push(observation);
          writer.appendLog(`heartbeat-active-hours: ${outcome}\n`);
        };
        await fireNext("active-fire");
        await cron.update(job.id, { activeHours: activeHours(true) });
        await fireNext("quiet-hours-skip");
        await cron.update(job.id, { activeHours: activeHours(false) });
        cron.stop();
        await cron.waitForIdle();
        await cron.start();
        await fireNext("active-fire");
      } finally {
        cron.stop();
        await cron.waitForIdle();
        await scheduler.stop();
      }
    });
    const summaryPath = path.join(options.artifactBase, "heartbeat-active-hours-summary.json");
    await fs.writeFile(
      summaryPath,
      `${JSON.stringify({ observations: phaseObservations }, null, 2)}\n`,
      "utf8",
    );
    return await writer.write({
      artifacts: [{ kind: "summary", filePath: summaryPath }],
      details:
        "Observed scheduled active fire, quiet-hours skip without execution, and persisted policy reload fire",
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
