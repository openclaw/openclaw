import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
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
import type { CronJob } from "./types.js";

const SCHEDULED_BACKUP_COMMAND = ["openclaw", "backup", "git", "create"];
const SCHEDULED_BACKUP_DECLARATION_KEY = "openclaw-backup-scheduled";

function makeCommandJob(payload: Extract<CronJob["payload"], { kind: "command" }>): CronJob {
  const now = Date.now();
  return {
    id: "command-job",
    name: "Command job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    state: {},
  };
}

describe("runCronCommandJob", () => {
  let receipts: FixtureReceiptChannel;
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts?.close();
  });

  it.each(["owned", "offsite", "display-only", "retargeted"])(
    "records only declared backup command custody through native settlement: %s",
    async (mode) => {
      const settled = createDeferred<SpawnResult>();
      const runCommand = vi
        .spyOn(processExecution, "runCommandWithTimeout")
        .mockReturnValue(settled.promise);
      const job = makeCommandJob({
        kind: "command",
        argv:
          mode === "retargeted"
            ? ["echo", "backup"]
            : mode === "offsite"
              ? ["openclaw", "backup", "create", "--to", "archive"]
              : [...SCHEDULED_BACKUP_COMMAND],
      });
      job.name = SCHEDULED_BACKUP_DECLARATION_KEY;
      if (mode !== "display-only") {
        job.declarationKey =
          mode === "offsite"
            ? "openclaw-backup-offsite-scheduled"
            : SCHEDULED_BACKUP_DECLARATION_KEY;
      }
      const ownsBackup = mode !== "display-only" && mode !== "retargeted";
      const running = runCronCommandJob({ job });
      try {
        expect(readLifecycleWriteCustody()).toEqual(
          ownsBackup ? [{ phase: "backup", count: 1 }] : [],
        );
        settled.resolve({
          code: null,
          signal: "SIGTERM",
          killed: true,
          stdout: "",
          stderr: "",
          termination: "timeout",
          cleanup: "forced",
        });
        expect((await running).status).toBe("error");
        expect(readLifecycleWriteCustody()).toEqual([]);
      } finally {
        settled.resolve({
          code: 0,
          signal: null,
          killed: false,
          stdout: "",
          stderr: "",
          termination: "exit",
        });
        await running;
        runCommand.mockRestore();
      }
    },
  );

  it.each(["normal", "uncertain"] as const)(
    "keeps maintenance unready until declared backup cleanup is confirmed: %s",
    async (outcome) => {
      const beginCustody = lifecycleWriteCustody.beginLifecycleWriteCustody;
      let releaseCustody: (() => void) | undefined;
      const begin = vi
        .spyOn(lifecycleWriteCustody, "beginLifecycleWriteCustody")
        .mockImplementation((phase) => {
          releaseCustody = beginCustody(phase);
          return releaseCustody;
        });
      const cleanup = createDeferred<SpawnResult["cleanup"]>();
      const response = Promise.resolve<SpawnResult>({
        code: null,
        signal: "SIGTERM",
        killed: true,
        stdout: "",
        stderr: "",
        termination: "signal",
        cleanup: "uncertain",
      });
      const runCommand = vi
        .spyOn(processExecution, "runCommandWithTimeout")
        .mockImplementation(() => {
          execSpawn.retainCommandProcessCleanup(cleanup.promise);
          return response;
        });
      const job = makeCommandJob({ kind: "command", argv: [...SCHEDULED_BACKUP_COMMAND] });
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
        releaseCustody?.();
        expect(getGatewaySuspendStatus("scheduled-backup-cleanup")).toMatchObject({
          status: "ready",
          writeCustody: [],
        });
        expect(readLifecycleWriteCustody()).toEqual([]);
      } finally {
        cleanup.resolve("normal");
        await running;
        releaseCustody?.();
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        resetGatewayWorkAdmission();
        begin.mockRestore();
        runCommand.mockRestore();
      }
    },
  );

  it.each([
    { output: "NO_REPLY\n", summary: "NO_REPLY", outputMaxBytes: undefined, truncated: false },
    {
      output: `Visit https://example.com/device and enter code ABCD-EFGH\n${"x".repeat(200)}`,
      summary: `action-required output preserved:\nVisit https://example.com/device and enter code ABCD-EFGH\n\n${"x".repeat(24)}`,
      outputMaxBytes: 24,
      truncated: true,
    },
  ])(
    "preserves deliverable command output %#",
    async ({ output, summary, outputMaxBytes, truncated }) => {
      const result = await runCronCommandJob({
        job: makeCommandJob({
          kind: "command",
          argv: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`],
          timeoutSeconds: 5,
          outputMaxBytes,
        }),
        nowMs: () => 123,
      });
      expect(result.status).toBe("ok");
      expect(result.errorClassification).toBeUndefined();
      expect(result.summary).toBe(summary);
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
      timeoutSeconds: 5,
      error: "command exited with code 7",
      errorClassification: { kind: "permanent" },
      failureNotificationDetail: { kind: "command-exit", exitCode: 7 },
      summary: "bad thing",
      diagnostic: { exitCode: 7 },
    },
    {
      script: "setInterval(() => {}, 1000)",
      timeoutSeconds: 0.05,
      error: "command timed out",
      errorClassification: { kind: "reason", reason: "timeout" },
      failureNotificationDetail: { kind: "command-timeout", mode: "wall-clock" },
      diagnostic: {},
    },
    {
      script: "setInterval(() => {}, 1000)",
      timeoutSeconds: 5,
      noOutputTimeoutSeconds: 0.05,
      error: "command produced no output before noOutputTimeoutSeconds",
      errorClassification: { kind: "reason", reason: "timeout" },
      failureNotificationDetail: { kind: "command-timeout", mode: "no-output" },
      diagnostic: {},
    },
    {
      script: "process.stdout.write('should not run')",
      timeoutSeconds: 5,
      abort: true,
      error: "command stopped",
      errorClassification: undefined,
      failureNotificationDetail: undefined,
      diagnostic: {},
    },
  ])(
    "reports command failure: $error",
    async ({
      script,
      timeoutSeconds,
      noOutputTimeoutSeconds,
      abort,
      error,
      errorClassification,
      failureNotificationDetail,
      summary,
      diagnostic,
    }) => {
      const controller = new AbortController();
      if (abort) {
        controller.abort();
      }
      const result = await runCronCommandJob({
        job: makeCommandJob({
          kind: "command",
          argv: [process.execPath, "-e", script],
          timeoutSeconds,
          noOutputTimeoutSeconds,
        }),
        abortSignal: controller.signal,
        nowMs: () => 456,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe(error);
      expect(result.errorClassification).toEqual(errorClassification);
      expect(result.failureNotificationDetail).toEqual(failureNotificationDetail);
      expect(result.summary).toBe(summary);
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
                kind: "command",
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
          await withinTest(
            Promise.race([receipts.waitFor(childPidPath, "ready"), settled]),
            signal,
          );
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
      return {
        signal: null,
        killed: result.termination === "timeout",
        stdout: "",
        stderr: "",
        cleanup: "uncertain",
        ...result,
      };
    });
  }

  it("keeps a timeout terminal and records the later uncertain cleanup", async () => {
    const runCommand = mockUncertainCleanupAfter({ code: 124, termination: "timeout" });
    try {
      const result = await runCronCommandJob({
        job: makeCommandJob({ kind: "command", argv: ["sleep", "60"], timeoutSeconds: 1 }),
        nowMs: () => 789,
      });

      expect(result).toMatchObject({
        status: "error",
        error: "command timed out",
        errorClassification: { kind: "reason", reason: "timeout" },
        failureNotificationDetail: { kind: "command-timeout", mode: "wall-clock" },
      });
      expect(result.diagnostics?.entries).toEqual([
        expect.objectContaining({ source: "exec", severity: "error", exitCode: 124 }),
        {
          ts: 789,
          source: "exec",
          severity: "error",
          message: 'Command cleanup could not confirm that owned work stopped: "sleep" "60"',
          exitCode: 124,
        },
      ]);
    } finally {
      runCommand.mockRestore();
    }
  });

  it("preserves clean-exit output and backup custody when later cleanup is uncertain", async () => {
    const beginCustody = lifecycleWriteCustody.beginLifecycleWriteCustody;
    let releaseCustody: ReturnType<typeof beginCustody> | undefined;
    const begin = vi
      .spyOn(lifecycleWriteCustody, "beginLifecycleWriteCustody")
      .mockImplementation((phase) => {
        releaseCustody = beginCustody(phase);
        return releaseCustody;
      });
    const runCommand = mockUncertainCleanupAfter({
      code: 0,
      termination: "exit",
      stdout: "Backup created",
      stderr: "Backup verification completed",
    });
    const job = makeCommandJob({ kind: "command", argv: [...SCHEDULED_BACKUP_COMMAND] });
    job.declarationKey = SCHEDULED_BACKUP_DECLARATION_KEY;
    try {
      const result = await runCronCommandJob({
        job,
        nowMs: () => 789,
      });

      expect(result).toMatchObject({
        status: "error",
        error: "Command cleanup could not confirm that owned work stopped",
        errorClassification: { kind: "permanent" },
        summary: "stdout:\nBackup created\n\nstderr:\nBackup verification completed",
      });
      expect(result.failureNotificationDetail).toBeUndefined();
      expect(result.diagnostics?.summary).toBe(result.summary);
      const command = SCHEDULED_BACKUP_COMMAND.map((arg) => JSON.stringify(arg)).join(" ");
      expect(result.diagnostics?.entries).toEqual([
        {
          ts: 789,
          source: "exec",
          severity: "error",
          message: `command error: ${command}`,
          exitCode: 0,
          truncated: false,
        },
        {
          ts: 789,
          source: "exec",
          severity: "error",
          message: `Command cleanup could not confirm that owned work stopped: ${command}`,
          exitCode: 0,
        },
      ]);
      expect(readLifecycleWriteCustody()).toEqual([{ phase: "backup", count: 1 }]);
    } finally {
      // This synthetic fixture has no native work; release only through its original owner.
      releaseCustody?.();
      begin.mockRestore();
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
          kind: "command",
          argv: [mode === "missing" ? "openclaw-command-that-does-not-exist" : process.execPath],
          timeoutSeconds: 5,
        }),
      });
      expect(result.status).toBe("error");
      expect(result.failureNotificationDetail).toBeUndefined();
      expect(result.errorClassification).toEqual(
        mode === "missing" ? { kind: "permanent" } : undefined,
      );
      if (mode === "transient") {
        expect(result.error).toBe("spawn EAGAIN");
      }
    } finally {
      runCommand?.mockRestore();
    }
  });
});
