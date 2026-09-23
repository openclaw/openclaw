import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { writeUpdateRunReportArtifact } from "../../infra/update-failure-report-artifact.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { UPDATE_RUN_HEARTBEAT_MS } from "../../infra/update-run-timeouts.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { formatCliJsonFailure } from "../failure-output.js";
import { createUpdateProgress, printResult } from "./progress.js";
import {
  reportUpdateCommandPendingRecovery,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";

vi.mock("../../infra/update-run-ledger.js", () => ({ getUpdateRun: vi.fn() }));
vi.mock("../../infra/update-failure-report-artifact.js", () => ({
  writeUpdateRunReportArtifact: vi.fn(),
}));

const runId = "6631ecee-adbf-41e8-a0e3-1b88b28b0a59";
const context = { runId, env: { OPENCLAW_STATE_DIR: "/isolated/update-progress" } };
const step = { name: "build", command: "pnpm build", index: 0, total: 1 };
const result = { runId, status: "ok" as const, mode: "git" as const, steps: [], durationMs: 1200 };
const reportPath = `/isolated/update-progress/${runId}.md`;

function runRecord(): UpdateRunRecord {
  return {
    runId,
    createdAtMs: 100,
    updatedAtMs: 100,
    trigger: "cli",
    status: "running",
    phase: "requested",
    reason: null,
    before: { version: "2026.9.2" },
    after: {},
    target: { version: "2026.9.3" },
    origin: {},
    steps: [{ step: "requested", status: "in_progress", startedAtMs: 100 }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
  };
}

describe("update progress", () => {
  let run: UpdateRunRecord;
  let presentation: ReturnType<typeof createUpdateProgress> | undefined;
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  beforeEach(() => {
    run = runRecord();
    vi.mocked(writeUpdateRunReportArtifact).mockReset().mockResolvedValue(reportPath);
    vi.mocked(getUpdateRun).mockImplementation(() => run);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  });

  afterEach(() => {
    presentation?.dispose();
    presentation = undefined;
    if (tty) {
      Object.defineProperty(process.stdout, "isTTY", tty);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replays rapid recorded phases once and preserves redirected step failures", () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    run.phase = "validating";
    run.steps.push(
      { step: "staging", status: "completed" },
      { step: "validating", status: "in_progress" },
    );
    presentation.progress.onStepStart?.(step);
    expect(log).toHaveBeenCalledWith("validating — build...");
    presentation.progress.onStepComplete?.({
      ...step,
      durationMs: 1200,
      exitCode: 1,
      stdoutTail: "Build type error",
    });
    const lines = log.mock.calls.flat();
    expect(lines.filter((line) => typeof line === "string" && line.startsWith("Phase:"))).toEqual([
      "Phase: requested",
      "Phase: staging",
      "Phase: validating",
    ]);
    expect(lines.join("\n")).toContain("Build type error");
  });

  it("keeps the report available when initial history observation fails", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.mocked(getUpdateRun).mockImplementationOnce(() => {
      throw new Error("initial ledger read failed");
    });
    try {
      presentation = createUpdateProgress(true, context);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("initial ledger read failed"));
      run.phase = "verifying";
      run.steps = [
        { step: "requested", status: "completed" },
        { step: "verifying", status: "in_progress" },
      ];
      await printResult(result, { run: context });
      const lines = log.mock.calls.flat();
      expect(lines.join("\n")).toContain("OpenClaw update in progress: verifying.");
      expect(lines.filter((line) => typeof line === "string" && line.startsWith("Phase:"))).toEqual(
        ["Phase: requested", "Phase: verifying"],
      );
    } finally {
      // Replace and dispose a leaked observer when this regression runs on old code.
      vi.mocked(getUpdateRun).mockImplementation(() => run);
      presentation = createUpdateProgress(true, context);
      presentation.dispose();
      presentation = undefined;
    }
  });

  it("releases the terminal spinner when its final ledger read fails", () => {
    vi.useFakeTimers();
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    const timerCount = vi.getTimerCount();
    const signals = ["SIGINT", "SIGTERM"] as const;
    const listenerCounts = signals.map((signal) => process.listenerCount(signal));
    presentation = createUpdateProgress(true, context);
    presentation.progress.onStepStart?.(step);
    expect(vi.getTimerCount()).toBeGreaterThan(timerCount);
    const failure = new Error("final ledger read failed");
    vi.mocked(getUpdateRun).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => presentation?.dispose()).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(failure.message));

    expect(vi.getTimerCount()).toBe(timerCount);
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(listenerCounts);
  });

  it("keeps unbound step presentation independent of ledger records", () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true);
    run.phase = "validating";
    run.steps.push({ step: "validating", status: "in_progress" });
    vi.mocked(getUpdateRun).mockImplementation(() => {
      throw new Error("unbound presentation must not read the ledger");
    });
    try {
      presentation.progress.onStepStart?.(step, run);
      presentation.progress.onStepComplete?.(
        { ...step, durationMs: 1200, exitCode: 1, stdoutTail: "Build type error" },
        run,
      );
      expect(log).toHaveBeenCalledWith("build...");
      expect(log.mock.calls.flat().join("\n")).toContain("Build type error");
      expect(
        log.mock.calls
          .flat()
          .filter((line) => typeof line === "string" && line.startsWith("Phase:")),
      ).toEqual([]);
    } finally {
      vi.mocked(getUpdateRun).mockImplementation(() => run);
    }
  });

  it.each([true, false])(
    "renders the report and phases from one snapshot (present: %s)",
    async (present) => {
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      presentation = createUpdateProgress(true, context);
      const captured: UpdateRunRecord = {
        ...run,
        phase: "verifying",
        steps: [
          { step: "requested", status: "completed" },
          { step: "verifying", status: "in_progress" },
        ],
      };
      const later: UpdateRunRecord = {
        ...captured,
        phase: "repairing",
        steps: [
          { step: "requested", status: "completed" },
          { step: "verifying", status: "completed" },
          { step: "repairing", status: "in_progress" },
        ],
      };
      vi.mocked(getUpdateRun)
        .mockReturnValueOnce(present ? captured : undefined)
        .mockReturnValue(later);
      try {
        const nextAction = "Update is not finished. Check progress: openclaw update status";
        await printResult(result, { run: context }, { nextAction });
        const lines = log.mock.calls.flat();
        expect(lines.at(-1)).toBe(nextAction);
        expect(lines.join("\n").match(/openclaw update status/g)).toHaveLength(1);
        expect(
          lines.filter((line) => typeof line === "string" && line.startsWith("Phase:")),
        ).toEqual(present ? ["Phase: requested", "Phase: verifying"] : ["Phase: requested"]);
        expect(lines.join("\n")).toContain(
          present ? "OpenClaw update in progress: verifying." : "OpenClaw updated.",
        );
        expect(log).not.toHaveBeenCalledWith("Phase: repairing");
      } finally {
        vi.mocked(getUpdateRun).mockImplementation(() => run);
      }
    },
  );

  it("prints the failure and saved report when history cannot be read", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    vi.mocked(getUpdateRun).mockImplementation(() => {
      throw new Error("history temporarily unavailable");
    });
    await printResult({ ...result, status: "error", reason: "doctor-failed" }, { run: context });
    const text = log.mock.calls.flat().join("\n");
    expect(text).toContain("OpenClaw update failed: doctor-failed");
    expect(text).toContain(`Report: ${reportPath}`);
  });

  it("settles the pending report before exit without reopening retained history", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const entered = createDeferred();
    const saved = createDeferred<string>();
    vi.mocked(writeUpdateRunReportArtifact).mockImplementation(async () => {
      entered.resolve();
      return saved.promise;
    });
    presentation = createUpdateProgress(true, context);
    log.mockClear();
    vi.mocked(getUpdateRun)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("retained history must not be reopened");
      });
    const reporting = reportUpdateCommandPendingRecovery(
      new UpdateCommandPendingRecoveryFailure({
        ...result,
        status: "error",
        reason: "update-recovery-pending",
      }),
      { json: true },
    );
    let exited = false;
    const completion = reporting.catch((error: unknown) => {
      exited = true;
      return error;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS);
      expect(getUpdateRun).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(exited).toBe(false);
      expect(writeUpdateRunReportArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ detached: true }),
      );
    } finally {
      saved.resolve(reportPath);
    }
    await expect(completion).resolves.toMatchObject({ code: 1 });
    expect(output).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "error", reason: "update-recovery-pending", reportPath }),
    );
    expect(getUpdateRun).not.toHaveBeenCalled();
  });

  it("prints the exact repair command from a recoverable step", () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    const message =
      "Skipped temporary cleanup. Run: rm -rf -- '/opt/update fixture/candidate'. Reason: permission denied";
    presentation.progress.onStepComplete?.({
      ...step,
      durationMs: 1,
      exitCode: 1,
      stderrTail: "permission denied",
      advisory: { kind: "recoverable-maintenance", message },
    });
    expect(log.mock.calls.flat().join("\n")).toContain(message);
  });

  it("shows recorded failure facts without replaying the child error envelope", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    const envelope = formatCliJsonFailure(new Error("Unable to load plugin"), {
      argv: [],
      env: {},
    });
    const failed = {
      ...step,
      durationMs: 1,
      exitCode: 1,
      stdoutTail: JSON.stringify(envelope),
      stderrTail:
        "[openclaw] The CLI command failed.\n[openclaw] Reason: Unable to load plugin\n[openclaw] Help: openclaw --help",
      failureFacts: [{ check: "doctor", code: "doctor-failed", message: "Unable to load plugin" }],
    };
    presentation.progress.onStepComplete?.(failed);
    const progress = log.mock.calls.flat().join("\n");
    expect(progress.match(/Unable to load plugin/gu)).toHaveLength(1);
    expect(progress).not.toContain("The CLI command failed");
    log.mockClear();
    await printResult(
      { ...result, runId: undefined, status: "error", steps: [{ ...failed, cwd: "/fixture" }] },
      {},
    );
    const report = log.mock.calls.flat().join("\n");
    expect(report.match(/Unable to load plugin/gu)).toHaveLength(1);
    expect(report).not.toContain("Help: openclaw --help");
    for (const stdoutTail of [
      "Additional diagnostic",
      JSON.stringify({ ...envelope, details: "Additional diagnostic" }),
    ]) {
      log.mockClear();
      const detailed = { ...failed, stdoutTail, cwd: "/fixture" };
      presentation.progress.onStepComplete?.(detailed);
      expect(log.mock.calls.flat().join("\n")).toContain("Additional diagnostic");
      log.mockClear();
      await printResult({ ...result, runId: undefined, status: "error", steps: [detailed] }, {});
      expect(log.mock.calls.flat().join("\n")).toContain("Additional diagnostic");
    }
    log.mockClear();
    await printResult(
      {
        ...result,
        runId: undefined,
        status: "error",
        steps: [
          {
            ...failed,
            cwd: "/fixture",
            stdoutTail: "x".repeat(160),
            stderrTail: `[openclaw] Reason: Unable to load plugin\nDistinct detail ${"y".repeat(160)}\n[openclaw] Help: openclaw --help\ndoctor: Candidate doctor failed (deadline exceeded) (1000ms)`,
          },
        ],
      },
      {},
    );
    expect(log.mock.calls.flat().join("\n")).toContain(`Distinct detail ${"y".repeat(40)}`);
    expect(log.mock.calls.flat().join("\n")).toContain("deadline exceeded");
    log.mockClear();
    presentation.progress.onStepComplete?.({
      ...failed,
      stdoutTail: undefined,
      stderrTail: undefined,
    });
    expect(
      log.mock.calls
        .flat()
        .join("\n")
        .match(/Unable to load plugin/gu),
    ).toHaveLength(1);
  });

  it("follows restart verification after step progress stops and flushes before the final report", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    presentation.stop();
    // The restarted gateway writes these phases while the CLI has no active step.
    run.phase = "verifying";
    run.steps.push(
      { step: "restarting", status: "completed" },
      { step: "verifying", status: "in_progress" },
    );
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Phase: verifying"));
    expect(log).toHaveBeenCalledWith("Phase: restarting");
    expect(log).not.toHaveBeenCalledWith("Phase: repairing");
    run.phase = "finished";
    run.status = "succeeded";
    run.after = { version: "2026.9.3" };
    run.verification = { serviceRunning: true, versionMatch: true };
    await printResult(result, { run: context });
    presentation.dispose();
    const lines = log.mock.calls.flat();
    const finalPhase = lines.indexOf("Phase: finished");
    const report = lines.findIndex(
      (line) => typeof line === "string" && line.includes("OpenClaw updated to 2026.9.3"),
    );
    expect(finalPhase).toBeGreaterThan(-1);
    expect(report).toBeGreaterThan(finalPhase);
    expect(lines.filter((line) => line === "Phase: verifying")).toHaveLength(1);
    expect(lines.filter((line) => line === "Phase: finished")).toHaveLength(1);
    expect(lines.join("\n")).toContain("service running; version verified");
  });

  it("omits private capture receipts from final JSON without mutating retained history", async () => {
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    run.origin.updateRecoveryCapture = {
      manifestSha256: "a".repeat(64),
      status: "pending",
      error: "private recovery detail",
      configWrites: [],
    };
    const retained = structuredClone(run);
    await printResult(result, { json: true, run: context });
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({
      ...result,
      run: { ...run, origin: {} },
      reportPath,
    });
    expect(JSON.stringify(writeJson.mock.calls)).not.toContain("private recovery detail");
    expect(run).toEqual(retained);
  });

  it("keeps JSON stdout silent until one result containing the durable row", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    presentation = createUpdateProgress(false, context);
    presentation.suspend();
    presentation.resume();
    presentation.progress.onStepStart?.(step);
    presentation.progress.onStepComplete?.({ ...step, durationMs: 1, exitCode: 0 });
    presentation.stop();
    run.phase = "finished";
    run.status = "succeeded";
    await printResult(result, { json: true, run: context });
    expect(log).not.toHaveBeenCalled();
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({ ...result, run, reportPath });
  });

  it.each([
    { history: "running", rolledBack: false },
    { history: "succeeded", rolledBack: false },
    { history: "rolled-back", rolledBack: false },
    { history: "rolled-back", rolledBack: true },
  ] as const)(
    "prints current failure facts over $history history (verified rollback=$rolledBack)",
    async ({ history, rolledBack }) => {
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      run.status = history;
      run.phase = history === "running" ? "verifying" : "finished";
      run.reason = rolledBack ? "doctor-failed" : "build-failed";
      run.after = { version: "2026.9.4" };
      run.target = { version: "2026.9.5" };
      const saved = structuredClone(run);
      const latest: UpdateRunResult = {
        ...result,
        status: "error",
        reason: "doctor-failed",
        before: { version: "2026.9.4" },
        after: { version: rolledBack ? "2026.9.4" : "2026.9.5" },
        verification: { runningVersion: "2026.9.4", versionMatch: rolledBack },
        ...(rolledBack
          ? {
              recovery: {
                serviceRestartSafe: true,
                packageRollbackVerified: true,
                service: "healthy",
                version: "2026.9.4",
              },
            }
          : {}),
      };

      await printResult(latest, { run: context });
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(
        rolledBack
          ? "OpenClaw update rolled back to 2026.9.4: doctor-failed"
          : "OpenClaw update failed: doctor-failed",
      );
      const identity = rolledBack ? "version verified" : "version mismatch";
      expect(output).toContain(identity);
      const publicReport = await prepareUpdateFailureReport(
        { attemptId: runId, result: latest, recordedRun: run },
        { env: {}, stateDir: "/isolated/update-progress" },
      );
      expect(publicReport.body).toContain(`Recorded verification: ${identity}`);
      await printResult(latest, { json: true, run: context });
      expect(writeJson).toHaveBeenCalledExactlyOnceWith({ ...latest, run: saved, reportPath });
      expect(run).toEqual(saved);
    },
  );

  it.each([true, false, undefined])(
    "prints raw recovery observations without rewriting saved history (running=%s)",
    async (serviceRunning) => {
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      run.status = "failed";
      run.phase = "finished";
      run.reason = "post-update-plugins";
      run.after = { version: "2026.9.5" };
      run.verification = {
        serviceRunning: serviceRunning !== true,
        runningVersion: "2026.8.99",
        versionMatch: true,
        readyz: true,
        settled: true,
        booted: true,
        noticeDelivered: true,
        doctorHint: "Retained lifecycle guidance",
        recovery:
          serviceRunning === true
            ? { serviceRestartSafe: false, reason: "state-migration-started" }
            : { serviceRestartSafe: true, version: "2026.8.99", service: "healthy" },
      };
      run.steps.push({
        step: "gateway recovery verification",
        status: "completed",
        exitCode: 0,
      });
      const saved = structuredClone(run);
      const latest: UpdateRunResult = {
        ...result,
        status: "error",
        reason: "post-update-plugins",
        after: run.after,
        verification:
          serviceRunning === undefined
            ? {}
            : {
                serviceRunning,
                runningVersion: "2026.9.5",
                versionMatch: true,
                readyz: serviceRunning,
                settled: serviceRunning,
              },
        ...(serviceRunning === true
          ? { recovery: { serviceRestartSafe: true, version: "2026.9.5", service: "healthy" } }
          : {}),
        steps:
          serviceRunning === undefined
            ? []
            : [
                {
                  name: "gateway recovery verification",
                  command: "gateway verification",
                  cwd: "/fixture",
                  durationMs: 0,
                  exitCode: serviceRunning ? 0 : 1,
                  ...(!serviceRunning
                    ? { failureFacts: [{ check: "service", code: "service-not-running" }] }
                    : {}),
                },
              ],
      };

      await printResult(latest, { run: context });

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("gateway booted");
      expect(output).toContain("Retained lifecycle guidance");
      expect(output).not.toContain("2026.8.99");
      if (serviceRunning === undefined) {
        expect(output).not.toContain("service running");
        expect(output).not.toContain("service stopped");
        expect(output).not.toContain("verified serving");
      } else {
        expect(output).toContain(serviceRunning ? "service running" : "service stopped");
        expect(output).toContain(
          serviceRunning
            ? "verified serving 2026.9.5; restart remains unsafe (state-migration-started)"
            : "not serving (service-not-running)",
        );
      }
      await printResult(latest, { json: true, run: context });
      expect(writeJson).toHaveBeenCalledExactlyOnceWith({ ...latest, run: saved, reportPath });
      expect(run).toEqual(saved);
    },
  );

  it("preserves a captured success receipt over stale raw recovery proof", async () => {
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const captured: UpdateRunRecord = {
      ...run,
      status: "succeeded",
      phase: "finished",
      after: { version: "2026.9.5" },
      steps: [{ step: "gateway recovery verification", status: "completed", exitCode: 0 }],
      verification: {
        serviceRunning: true,
        runningVersion: "2026.9.5",
        versionMatch: true,
        readyz: true,
        settled: true,
        channelsReady: true,
        pluginErrors: [],
        recovery: { serviceRestartSafe: true, version: "2026.9.5", service: "healthy" },
      },
      confirmedAtMs: 300,
      finishedAtMs: 301,
    };
    const saved = structuredClone(captured);
    const stale: UpdateRunResult = {
      ...result,
      after: captured.after,
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
      steps: [
        {
          name: "gateway recovery verification",
          command: "gateway verification",
          cwd: "/fixture",
          durationMs: 1,
          exitCode: 1,
          failureFacts: [{ check: "settled", code: "stale-readiness-failure" }],
        },
      ],
    };
    const read = vi
      .mocked(getUpdateRun)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("Captured terminal publication must not reopen history.");
      });

    await printResult(stale, { run: context }, { record: captured });

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("OpenClaw updated to 2026.9.5");
    expect(output).toContain("Recovery: verified serving 2026.9.5.");
    expect(output).not.toContain("stale-readiness-failure");
    expect(output).not.toContain("state-migration-started");
    await printResult(stale, { json: true, run: context }, { record: captured });
    expect(writeJson).toHaveBeenCalledExactlyOnceWith({ ...stale, run: saved, reportPath });
    expect(read).not.toHaveBeenCalled();
    expect(captured).toEqual(saved);
  });

  it("suspends every ledger reader through activation and resumes the recorded timeline", () => {
    vi.useFakeTimers();
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    presentation = createUpdateProgress(true, context);
    presentation.suspend();
    const read = vi
      .mocked(getUpdateRun)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("candidate owns the migrated ledger");
      });
    presentation.progress.onStepStart?.(step);
    presentation.progress.onStepComplete?.({ ...step, durationMs: 10, exitCode: 0 });
    vi.advanceTimersByTime(500);
    expect(read).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("build...");

    run.phase = "verifying";
    run.steps.push(
      { step: "activating", status: "completed" },
      { step: "restarting", status: "completed" },
      { step: "verifying", status: "in_progress" },
    );
    read.mockImplementation(() => run);
    presentation.resume();
    vi.advanceTimersByTime(500);
    expect(read).toHaveBeenCalled();
    expect(
      log.mock.calls.flat().filter((line) => typeof line === "string" && line.startsWith("Phase:")),
    ).toEqual(["Phase: requested", "Phase: activating", "Phase: restarting", "Phase: verifying"]);

    presentation.suspend();
    read.mockClear().mockImplementation(() => {
      throw new Error("candidate owns the migrated ledger");
    });
    presentation.dispose();
    presentation.dispose();
    presentation.resume();
    vi.advanceTimersByTime(500);
    expect(read).not.toHaveBeenCalled();
  });
});
