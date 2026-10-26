import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
import { runCronCommandJob } from "./command-runner.js";
import { cronTestJob } from "./service.fixture-builders.test-support.js";
import type { CronJob } from "./types.js";

const SCHEDULED_BACKUP_COMMAND = ["openclaw", "backup", "git", "create"];
const SCHEDULED_BACKUP_DECLARATION_KEY = "openclaw-backup-scheduled";

type CommandPayload = Extract<CronJob["payload"], { kind: "command" }>;
function makeCommandJob(payload: Omit<CommandPayload, "kind">): CronJob {
  return cronTestJob({
    id: "command-job",
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
      expect(runCommand).toHaveBeenCalledWith(
        [...argv],
        expect.objectContaining({ killProcessTree: true, timeoutMs: 600_000 }),
      );
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
    expect(result.diagnostics?.entries).toHaveLength(2);
    for (const entry of result.diagnostics?.entries ?? []) {
      expect(entry).toMatchObject({
        source: "exec",
        severity: "error",
        exitCode: timeout ? 124 : 0,
      });
    }
    expect(result.diagnostics?.entries[1]?.message).toContain(
      "Command cleanup could not confirm that owned work stopped",
    );
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
