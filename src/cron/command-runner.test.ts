import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { startProcessWatchdogFixture } from "../../test/helpers/process-watchdog.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
} from "../infra/gateway-suspend-coordinator.js";
import { inspectors } from "../infra/gateway-suspend-coordinator.test-support.js";
import * as lifecycleWriteCustody from "../infra/lifecycle-write-custody.js";
import { readLifecycleWriteCustody } from "../infra/lifecycle-write-custody.js";
import type { SpawnResult } from "../process/exec-result.js";
import * as execSpawn from "../process/exec-spawn.js";
import * as processExecution from "../process/exec.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { readPidFile } from "../test-utils/process-tree.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { runCronCommandJob } from "./command-runner.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import type { CronJob } from "./types.js";

const SCHEDULED_BACKUP_COMMAND = ["openclaw", "backup", "git", "create"];
const SCHEDULED_BACKUP_DECLARATION_KEY = "openclaw-backup-scheduled";

type CommandPayload = Extract<CronJob["payload"], { kind: "command" }>;
function makeCommandJob(payload: Omit<CommandPayload, "kind">): CronJob {
  return cronTestJob({
    id: "command-job",
    name: "Command job",
    wakeMode: "now",
    payload: { kind: "command", ...payload },
  });
}

function makeSpawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    code: 0,
    signal: null,
    killed: false,
    stdout: "",
    stderr: "",
    termination: "exit",
    ...overrides,
  };
}

function runNode(
  script: string,
  options: Omit<CommandPayload, "kind" | "argv">,
  now: number,
  abortSignal?: AbortSignal,
) {
  return runCronCommandJob({
    job: makeCommandJob({ argv: [process.execPath, "-e", script], ...options }),
    nowMs: () => now,
    abortSignal,
  });
}

function expectOutcome(result: Awaited<ReturnType<typeof runCronCommandJob>>, expected: object) {
  expect({
    summary: undefined,
    errorClassification: undefined,
    failureNotificationDetail: undefined,
    ...result,
  }).toEqual(expect.objectContaining(expected));
}

function captureCustody() {
  const beginCustody = lifecycleWriteCustody.beginLifecycleWriteCustody;
  let release: ReturnType<typeof beginCustody> | undefined;
  const spy = vi
    .spyOn(lifecycleWriteCustody, "beginLifecycleWriteCustody")
    .mockImplementation((phase) => {
      release = beginCustody(phase);
      return release;
    });
  return { release: () => release?.(), restore: () => spy.mockRestore() };
}

it.each([
  ["owned", SCHEDULED_BACKUP_COMMAND, SCHEDULED_BACKUP_DECLARATION_KEY, true],
  [
    "offsite",
    ["openclaw", "backup", "create", "--to", "archive"],
    "openclaw-backup-offsite-scheduled",
    true,
  ],
  ["display-only", SCHEDULED_BACKUP_COMMAND, undefined, false],
  ["retargeted", ["echo", "backup"], SCHEDULED_BACKUP_DECLARATION_KEY, false],
] as const)(
  "records only declared backup command custody through native settlement: %s",
  async (_mode, argv, declarationKey, ownsBackup) => {
    const settled = createDeferred<SpawnResult>();
    const runCommand = vi
      .spyOn(processExecution, "runCommandWithTimeout")
      .mockReturnValue(settled.promise);
    const job = {
      ...makeCommandJob({ argv: [...argv] }),
      name: SCHEDULED_BACKUP_DECLARATION_KEY,
      declarationKey,
    };
    const running = runCronCommandJob({ job });
    try {
      expect(readLifecycleWriteCustody()).toEqual(
        ownsBackup ? [{ phase: "backup", count: 1 }] : [],
      );
      settled.resolve(
        makeSpawnResult({
          code: null,
          signal: "SIGTERM",
          killed: true,
          termination: "timeout",
          cleanup: "forced",
        }),
      );
      expect((await running).status).toBe("error");
      expect(readLifecycleWriteCustody()).toEqual([]);
    } finally {
      settled.resolve(makeSpawnResult());
      await running;
      runCommand.mockRestore();
    }
  },
);

it.each(["normal", "uncertain"] as const)(
  "keeps maintenance unready until declared backup cleanup is confirmed: %s",
  async (outcome) => {
    const custody = captureCustody();
    const cleanup = createDeferred<SpawnResult["cleanup"]>();
    const response = Promise.resolve(
      makeSpawnResult({
        code: null,
        signal: "SIGTERM",
        killed: true,
        termination: "signal",
        cleanup: "uncertain",
      }),
    );
    const runCommand = vi
      .spyOn(processExecution, "runCommandWithTimeout")
      .mockImplementation(() => {
        execSpawn.retainCommandProcessCleanup(cleanup.promise);
        return response;
      });
    const job = makeCommandJob({ argv: [...SCHEDULED_BACKUP_COMMAND] });
    job.declarationKey = SCHEDULED_BACKUP_DECLARATION_KEY;
    const running = runCronCommandJob({ job });
    try {
      await response;
      expect(readLifecycleWriteCustody()).toEqual([{ phase: "backup", count: 1 }]);
      cleanup.resolve(outcome);
      expect((await running).status).toBe("error");
      expect(
        prepareGatewaySuspend({
          requestId: "scheduled-backup-cleanup",
          drain: true,
          pauseScheduling: () => {},
          resumeScheduling: () => {},
          inspect: inspectors(),
          createSuspensionId: () => "scheduled-backup-cleanup",
        }),
      ).toMatchObject(
        outcome === "uncertain"
          ? {
              status: "draining",
              activeCount: 1,
              writeCustody: [{ phase: "backup", count: 1 }],
            }
          : { status: "ready", writeCustody: [] },
      );
      // Only the original owner can release after independent proof of settlement.
      // This fixture has no live native process; resolving the scope did not prove that.
      custody.release();
      expect(getGatewaySuspendStatus("scheduled-backup-cleanup")).toMatchObject({
        status: "ready",
        writeCustody: [],
      });
      expect(readLifecycleWriteCustody()).toEqual([]);
    } finally {
      cleanup.resolve("normal");
      await running;
      custody.release();
      resetGatewaySuspendCoordinatorForLifecycleRestart();
      resetGatewayWorkAdmission();
      custody.restore();
      runCommand.mockRestore();
    }
  },
);

it.each<
  [output: string, summary: string | undefined, outputMaxBytes?: number, truncated?: boolean]
>([
  ["NO_REPLY\n", undefined],
  ["NO_REPLY\nNO_REPLY", "NO_REPLY"],
  ["NO_REPLY.", "NO_REPLY."],
  ['{"action":"NO_REPLY"}', '{"action":"NO_REPLY"}'],
  ['"NO_REPLY"', '"NO_REPLY"'],
  ["No channel reply.", "No channel reply."],
  [" NO_REPLY\nReport", "NO_REPLY\nReport"],
  [
    `Visit https://example.com/device and enter code ABCD-EFGH\n${"x".repeat(200)}`,
    `action-required output preserved:\nVisit https://example.com/device and enter code ABCD-EFGH\n\n${"x".repeat(24)}`,
    24,
    true,
  ],
])(
  "preserves deliverable command output %#",
  async (output, summary, outputMaxBytes, truncated = false) => {
    const result = await runNode(
      `process.stdout.write(${JSON.stringify(output)})`,
      { timeoutSeconds: 5, outputMaxBytes },
      123,
    );
    expectOutcome(result, { status: "ok", errorClassification: undefined, summary });
    expect(result.diagnostics?.summary).toBe(summary);
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 123,
      source: "exec",
      severity: "info",
      exitCode: 0,
      truncated,
    });
  },
);

it.each([
  {
    script: "process.stderr.write('bad thing'); process.exit(7)",
    options: { timeoutSeconds: 5 },
    expected: {
      error: "command exited with code 7",
      errorClassification: { kind: "permanent" },
      failureNotificationDetail: { kind: "command-exit", exitCode: 7 },
      summary: "bad thing",
    },
    diagnostic: { exitCode: 7 },
  },
  {
    script: "setInterval(() => {}, 1000)",
    options: { timeoutSeconds: 5, noOutputTimeoutSeconds: 0.05 },
    expected: {
      error: "command produced no output before noOutputTimeoutSeconds",
      errorClassification: { kind: "reason", reason: "timeout" },
      failureNotificationDetail: { kind: "command-timeout", mode: "no-output" },
    },
  },
  {
    script: "process.stdout.write('should not run')",
    options: { timeoutSeconds: 5 },
    abort: true,
    expected: { error: "command stopped" },
  },
])(
  "reports command failure: $expected.error",
  async ({ script, options, abort, expected, diagnostic }) => {
    const controller = new AbortController();
    if (abort) {
      controller.abort();
    }
    const result = await runNode(script, options, 456, controller.signal);
    expectOutcome(result, {
      status: "error",
      summary: undefined,
      errorClassification: undefined,
      failureNotificationDetail: undefined,
      ...expected,
    });
    expect(result.diagnostics?.entries[0]).toMatchObject({
      ts: 456,
      source: "exec",
      severity: "error",
      ...diagnostic,
    });
  },
);

it.skipIf(process.platform === "win32")(
  "kills shell process groups on timeout",
  async ({ signal }) =>
    withTempDir("openclaw-cron-command-", async (tempDir) => {
      const receipts = await openFixtureReceiptChannel();
      await using _ = { [Symbol.asyncDispose]: () => receipts.close() };
      const childPidPath = path.join(tempDir, "child.pid");
      const childPath = path.join(tempDir, "child.mjs");
      await fs.writeFile(
        childPath,
        [
          fixtureReceiptClientSource(receipts.endpoint),
          'import { writeFileSync } from "node:fs";',
          "setInterval(() => {}, 1000);",
          `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          `sendReceipt(${JSON.stringify(childPidPath)}, "ready");`,
        ].join("\n"),
      );
      const shellCommand = [
        `${JSON.stringify(process.execPath)} ${JSON.stringify(childPath)} &`,
        "child_pid=$!",
        'wait "$child_pid"',
      ].join("\n");

      const controller = new AbortController();
      const spawnSpy = vi.spyOn(execSpawn, "spawnCommandWithInvocation");
      let parent: ChildProcess | undefined;
      let releaseAndWait: (() => ReturnType<typeof runCronCommandJob>) | undefined;
      let running: ReturnType<typeof runCronCommandJob> | undefined;
      try {
        // Hold only the command deadline until the child is live. Group exit
        // observation and scoped cleanup must keep real time to observe the OS.
        releaseAndWait = startProcessWatchdogFixture(() => {
          running = runCronCommandJob({
            job: makeCommandJob({
              argv: ["sh", "-lc", shellCommand],
              timeoutSeconds: 0.5,
            }),
            abortSignal: controller.signal,
          });
          return running;
        });
        const spawnResult = spawnSpy.mock.results[0];
        if (!running || spawnResult?.type !== "return") {
          throw new Error("command did not spawn");
        }
        parent = spawnResult.value.child.nodeChildProcess;
        // The child records readiness before reporting it on the independent socket.
        const settled = running.then(() => {
          if (!existsSync(childPidPath)) {
            throw new Error("command settled before its shell descendant became live");
          }
        });
        await withinTest(Promise.race([receipts.waitFor(childPidPath, "ready"), settled]), signal);
        const childPid = await readPidFile(childPidPath);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(isPidAlive(childPid)).toBe(true);

        const result = await withinTest(releaseAndWait(), signal);
        expect(result.status).toBe("error");
        expect(result.error).toBe("command timed out");
        // Scope cleanup has settled, but it exposes no exact adopted-child reap event.
        while (isPidAlive(childPid)) {
          await delay(25, undefined, { signal }).catch((error: unknown) => {
            throw new Error(`Cron shell descendant ${childPid} stayed alive`, { cause: error });
          });
        }
        expect(isPidAlive(childPid)).toBe(false);
      } finally {
        try {
          controller.abort();
          if (parent?.pid) {
            try {
              process.kill(-parent.pid, "SIGKILL");
            } catch {
              // The command may already have reaped its process group.
            }
          }
        } finally {
          spawnSpy.mockRestore();
          await releaseAndWait?.();
        }
      }
    }),
);

function mockUncertainCleanupAfter(
  result: Pick<SpawnResult, "code" | "termination"> &
    Partial<Pick<SpawnResult, "stdout" | "stderr">>,
) {
  return vi.spyOn(processExecution, "runCommandWithTimeout").mockImplementation(async () => {
    execSpawn.retainCommandProcessCleanup(Promise.resolve("uncertain"));
    return makeSpawnResult({
      killed: result.termination === "timeout",
      cleanup: "uncertain",
      ...result,
    });
  });
}

it.each([
  ["keeps a timeout terminal and records the later uncertain cleanup", true],
  ["preserves clean-exit output and backup custody when later cleanup is uncertain", false],
] as const)("%s", async (_name, timeout) => {
  const custody = timeout ? undefined : captureCustody();
  const runCommand = mockUncertainCleanupAfter(
    timeout
      ? { code: 124, termination: "timeout" }
      : {
          code: 0,
          termination: "exit",
          stdout: "Backup created",
          stderr: "Backup verification completed",
        },
  );
  const job = timeout
    ? makeCommandJob({ argv: ["sleep", "60"], timeoutSeconds: 1 })
    : makeCommandJob({ argv: [...SCHEDULED_BACKUP_COMMAND] });
  if (!timeout) {
    job.declarationKey = SCHEDULED_BACKUP_DECLARATION_KEY;
  }
  try {
    const result = await runCronCommandJob({ job, nowMs: () => 789 });
    expect(result).toMatchObject(
      timeout
        ? {
            status: "error",
            error: "command timed out",
            errorClassification: { kind: "reason", reason: "timeout" },
            failureNotificationDetail: { kind: "command-timeout", mode: "wall-clock" },
          }
        : {
            status: "error",
            error: "Command cleanup could not confirm that owned work stopped",
            errorClassification: { kind: "permanent" },
            summary: "stdout:\nBackup created\n\nstderr:\nBackup verification completed",
          },
    );
    const command = timeout
      ? '"sleep" "60"'
      : SCHEDULED_BACKUP_COMMAND.map((arg) => JSON.stringify(arg)).join(" ");
    const diagnostic = {
      ts: 789,
      source: "exec",
      severity: "error",
      exitCode: timeout ? 124 : 0,
    };
    expect(result.diagnostics?.entries).toEqual([
      timeout
        ? expect.objectContaining({ source: "exec", severity: "error", exitCode: 124 })
        : { ...diagnostic, message: `command error: ${command}`, truncated: false },
      {
        ...diagnostic,
        message: `Command cleanup could not confirm that owned work stopped: ${command}`,
      },
    ]);
    if (!timeout) {
      expect(result.failureNotificationDetail).toBeUndefined();
      expect(result.diagnostics?.summary).toBe(result.summary);
      expect(readLifecycleWriteCustody()).toEqual([{ phase: "backup", count: 1 }]);
    }
  } finally {
    // No native work in this fixture: only its original owner releases custody.
    custody?.release();
    custody?.restore();
    runCommand.mockRestore();
  }
});

it.each(["missing", "transient"])("classifies %s command start failures", async (mode) => {
  const runCommand =
    mode === "transient"
      ? vi
          .spyOn(processExecution, "runCommandWithTimeout")
          .mockRejectedValueOnce(Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }))
      : undefined;
  try {
    const result = await runCronCommandJob({
      job: makeCommandJob({
        argv: [mode === "missing" ? "openclaw-command-that-does-not-exist" : process.execPath],
        timeoutSeconds: 5,
      }),
    });
    expectOutcome(result, {
      status: "error",
      failureNotificationDetail: undefined,
      errorClassification: mode === "missing" ? { kind: "permanent" } : undefined,
    });
    if (mode === "transient") {
      expect(result.error).toBe("spawn EAGAIN");
    }
  } finally {
    runCommand?.mockRestore();
  }
});
