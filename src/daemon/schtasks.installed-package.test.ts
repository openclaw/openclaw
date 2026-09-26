import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveEnvironmentValue } from "../infra/process-env.js";
import * as updateRunReader from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as installedCommand from "./schtasks.installed-command.test-support.js";
import {
  readInstalledUpdateProgress,
  inspectInstalledUpdateFailure,
  parseInstalledUpdateResult,
  runInstalledPublishedUpdate,
  type InstalledTask,
} from "./schtasks.installed-diagnostics.test-support.js";
import * as installedPackage from "./schtasks.installed-package.test-support.js";
import {
  boundedEnv,
  resolveInstalledCellBodyTimeoutMs,
  keys,
} from "./schtasks.installed-package.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const candidateCheckNames = [
  "candidate migration rehearsal",
  "candidate doctor lint",
  "candidate config validation",
  "candidate plugin resolution",
  "candidate migration continuation",
  "candidate gateway canary",
];

it.each([
  { name: "candidate migration continuation", exitCode: 0 },
  { name: "candidate migration continuation", exitCode: null },
  { name: "candidate migration continuation", exitCode: undefined },
  { name: "candidate gateway canary", exitCode: 1 },
  { name: "candidate doctor lint", exitCode: undefined },
])(
  "requires every candidate check and keeps only safe proof ($name exit=$exitCode)",
  ({ name, exitCode }) => {
    const privatePayload = "synthetic-private-command-payload";
    const checks = candidateCheckNames.flatMap((check) =>
      check === name && exitCode === undefined
        ? []
        : [{ name: check, exitCode: check === name ? exitCode : 0, durationMs: 12 }],
    );
    const value = {
      status: "ok",
      mode: "npm",
      run: { privatePayload },
      steps: [
        { name: privatePayload, exitCode: 0, durationMs: 1 },
        ...checks.map((check) => ({
          ...check,
          command: privatePayload,
          cwd: privatePayload,
          stdoutTail: privatePayload,
        })),
      ],
    };
    if (exitCode !== 0) {
      expect(() => parseInstalledUpdateResult(value)).toThrow(
        `Published updater must pass ${name}`,
      );
      return;
    }
    const observed = parseInstalledUpdateResult(value);
    expect(observed).toEqual({ status: "ok", mode: "npm", steps: checks });
    expect(JSON.stringify(observed)).not.toContain(privatePayload);
  },
);

it("captures failed installed update progress without changing the ledger or retaining payloads", async () => {
  const {
    createUpdateRun,
    getUpdateRun,
    recordUpdateRunPhase,
    recordUpdateRunStep,
    recordUpdateRunVerification,
  } = await import("../infra/update-run-ledger.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.js");
  const env = { OPENCLAW_STATE_DIR: temporary.make("installed-update-progress-") };
  const options = { env };
  const privatePayload = "synthetic-private-update-payload";
  try {
    const run = createUpdateRun(
      {
        trigger: "cli",
        origin: { nextAction: privatePayload },
      },
      options,
    );
    recordUpdateRunPhase(
      run.runId,
      "validating",
      {
        after: { version: "2026.9.6", buildId: "candidate-build", sha: privatePayload },
      },
      options,
    );
    recordUpdateRunStep(
      run.runId,
      {
        step: "global update",
        status: "completed",
        startedAtMs: 100,
        endedAtMs: 200,
        detail: privatePayload,
      },
      options,
    );
    recordUpdateRunStep(
      run.runId,
      {
        step: "warning:managed-service-reconciliation",
        status: "completed",
        detail: "Synthetic native warning; token=synthetic-hidden-credential",
      },
      options,
    );
    recordUpdateRunVerification(
      run.runId,
      {
        serviceRunning: true,
        pid: 4321,
        port: 19417,
        runningVersion: "2026.9.6",
        runningBuildId: "candidate-build",
        versionMatch: true,
        channelsReady: true,
        readyz: false,
        settled: false,
        pluginErrors: [privatePayload],
        doctorHint: privatePayload,
      },
      options,
    );
    const before = getUpdateRun(run.runId, options);
    const observed = await readInstalledUpdateProgress({ env, stateDir: env.OPENCLAW_STATE_DIR });
    expect(observed).toMatchObject({ phase: "validating", status: "running" });
    expect(observed).toMatchObject({
      after: { version: "2026.9.6", buildId: "candidate-build" },
      verification: { serviceRunning: true, pid: 4321, port: 19417, readyz: false, settled: false },
    });
    expect(JSON.stringify(observed)).toContain("Synthetic native warning");
    expect(JSON.stringify(observed)).not.toContain("synthetic-hidden-credential");
    expect(observed).toHaveProperty(
      "steps",
      expect.arrayContaining([
        { step: "global update", status: "completed", startedAtMs: 100, endedAtMs: 200 },
      ]),
    );
    expect(JSON.stringify(observed)).not.toContain(privatePayload);
    expect(observed).not.toHaveProperty("origin");
    expect(getUpdateRun(run.runId, options)).toEqual(before);
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
});

it("reports unavailable installed progress without creating a missing database", async () => {
  const { readdir } = await import("node:fs/promises");
  const root = temporary.make("installed-update-no-ledger-");
  await expect(
    readInstalledUpdateProgress({ env: { OPENCLAW_STATE_DIR: root }, stateDir: root }),
  ).resolves.toEqual({
    unavailable: "No recorded update run",
  });
  expect(await readdir(root)).toEqual([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["PSMODULEANALYSISCACHEPATH", "PSModuleAnalysisCachePath"])(
  "preserves native %s and mixed-case Path while isolating application state",
  (cacheKey) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    for (const key of Object.keys(process.env)) {
      if (["PATH", "APPDATA", "TEMP", "PSMODULEANALYSISCACHEPATH"].includes(key.toUpperCase())) {
        vi.stubEnv(key, undefined);
      }
    }
    const nativePath = "C:\\native-tools";
    const moduleCache = "C:\\native-cache\\ModuleAnalysisCache";
    vi.stubEnv("Path", nativePath);
    vi.stubEnv(cacheKey, moduleCache);
    vi.stubEnv("appData", "C:\\native-profile\\roaming");
    vi.stubEnv("temp", "C:\\native-temp");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-do-not-forward");
    vi.stubEnv("NODE_OPTIONS", "--inspect");
    const root = path.resolve("synthetic-installed-fixture");
    const prefix = path.join(root, "prefix");
    const result = boundedEnv(root, prefix);

    expect(resolveEnvironmentValue(result, "PATH", "win32")).toContain(nativePath);
    expect(Object.keys(result).filter((key) => key.toUpperCase() === "PATH")).toHaveLength(1);
    expect(resolveEnvironmentValue(result, "APPDATA", "win32")).toBe(path.join(root, "appdata"));
    expect(resolveEnvironmentValue(result, "TEMP", "win32")).toBe(path.join(root, "tmp"));
    expect(result.OPENCLAW_STATE_DIR).toBe(path.join(root, "state"));
    expect(result.OPENCLAW_CONFIG_PATH).toBe(path.join(root, "openclaw.json"));
    expect(result.npm_config_prefix).toBe(prefix);
    expect(result.npm_config_cache).toBe(path.join(root, "npm-cache"));
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
    expect(resolveEnvironmentValue(result, "PSMODULEANALYSISCACHEPATH", "win32")).toBe(moduleCache);
  },
);

it("reserves cleanup and runner time within the installed native workflow", async () => {
  const { createE2EVitestConfig } = await import("../../test/vitest/vitest.e2e.config.ts");
  const cleanupMs = z.number().int().positive().parse(createE2EVitestConfig().test?.hookTimeout);
  const workflow = z
    .object({
      jobs: z.object({
        "native-schtasks-package": z.object({
          "timeout-minutes": z.number().int().positive(),
          steps: z.array(
            z.object({
              env: z.record(z.string(), z.unknown()).optional(),
              "timeout-minutes": z.number().int().positive().optional(),
            }),
          ),
        }),
      }),
    })
    .parse(parse(readFileSync(".github/workflows/windows-testbox-probe.yml", "utf8")));
  const job = workflow.jobs["native-schtasks-package"];
  let totalStepMs = 0;
  for (const cell of keys) {
    const steps = job.steps.filter(
      (step) =>
        typeof step.env?.CI_WINDOWS_SCHTASKS_INSTALLED_INPUT === "string" &&
        step.env.CI_WINDOWS_SCHTASKS_INSTALLED_CELL === cell,
    );
    expect(steps, cell).toHaveLength(1);
    const stepMinutes = z.number().int().positive().parse(steps[0]?.["timeout-minutes"]);
    const stepMs = stepMinutes * 60_000;
    expect(stepMs, cell).toBeGreaterThanOrEqual(
      resolveInstalledCellBodyTimeoutMs(cell) + cleanupMs + 60_000,
    );
    totalStepMs += stepMs;
  }
  expect(job["timeout-minutes"]).toBe(75);
  // Setup, package preparation, evidence retention, and retirement need room outside the cells.
  expect(totalStepMs).toBeLessThan(job["timeout-minutes"] * 60_000);
});

describe("published installed update progress", () => {
  const invokedAt = 1_800_000_000_000;
  const success = {
    status: "ok",
    mode: "npm",
    steps: candidateCheckNames.map((name) => ({ name, exitCode: 0, durationMs: 12 })),
  };
  const input: Awaited<ReturnType<typeof installedPackage.readInput>> = {
    sourceSha: "a".repeat(40),
    toolingSha: "b".repeat(40),
    tarball: "C:\\synthetic-candidate.tgz",
    candidate: {
      name: "openclaw",
      packageSourceSha: "a".repeat(40),
      version: "2026.9.26",
      sha256: "c".repeat(64),
    },
    installRoot: "C:\\synthetic-update\\prefix",
    stateRoot: "C:\\synthetic-update\\state",
    runtime: { version: "v24.0.0", sha256: "d".repeat(64) },
    artifact: {
      id: 1,
      runId: 2,
      runAttempt: 1,
      workflowSha: "b".repeat(40),
      digest: `sha256:${"e".repeat(64)}`,
    },
    published: ["2026.9.3", "2026.9.4"].map((version) => ({
      source: "npm-registry",
      version,
      commit: "f".repeat(40),
      tarball: `C:\\synthetic-${version}.tgz`,
      metadata: `C:\\synthetic-${version}.json`,
      sha256: "a".repeat(64),
      integrity: "sha512-synthetic",
    })),
  };
  const completedStep: UpdateRunRecord["steps"][number] = {
    step: "global update",
    status: "completed",
    startedAtMs: invokedAt + 1,
    endedAtMs: invokedAt + 2,
  };

  function recordedRun(
    steps: UpdateRunRecord["steps"],
    createdAtMs = invokedAt + 1,
  ): UpdateRunRecord {
    return {
      runId: "00000000-0000-0000-0000-000000000000",
      createdAtMs,
      updatedAtMs: invokedAt + 2,
      trigger: "cli",
      phase: "validating",
      status: "running",
      reason: null,
      origin: {},
      target: {},
      before: {},
      after: {},
      steps,
      verification: {},
      repair: [],
      confirmedAtMs: null,
      finishedAtMs: null,
      downtimeMs: null,
    };
  }

  function installedTask(): InstalledTask {
    return {
      profile: "synthetic-update",
      taskName: "OpenClaw Gateway (synthetic-update)",
      stateDir: "C:\\synthetic-update\\state",
      configPath: "C:\\synthetic-update\\state\\openclaw.json",
      scriptPath: "C:\\synthetic-update\\gateway.cmd",
      gatewayPort: 19417,
      rootDir: "C:\\synthetic-update",
      installRoot: "C:\\synthetic-update\\prefix",
      entry: "C:\\synthetic-update\\prefix\\openclaw.mjs",
      env: { OPENCLAW_STATE_DIR: "C:\\synthetic-update\\state" },
    };
  }

  function startUpdate(
    recordProgress = vi
      .fn<(phase: string, error?: Error) => Promise<void>>()
      .mockResolvedValue(undefined),
  ) {
    const task = installedTask();
    const command = createDeferredCore<string>();
    vi.spyOn(installedCommand, "run").mockReturnValue(command.promise);
    const observations: Record<string, unknown> = {};
    const pending = runInstalledPublishedUpdate({
      task,
      input,
      inputPath: "C:\\synthetic-input.json",
      key: "2026.9.3",
      commands: [],
      signal: new AbortController().signal,
      observations,
      recordProgress,
    });
    return { command, observations, pending, recordProgress };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(invokedAt);
    vi.spyOn(installedPackage, "recordCapacityBoundary").mockResolvedValue({
      boundary: "synthetic-update",
      cell: "2026.9.3",
      availableBytes: 100_000_000_000,
      freeBytes: 100_000_000_000,
      totalBytes: 200_000_000_000,
      profileHomeAvailableBytes: 100_000_000_000,
      expectedProfileState: [],
      installAndStaging: [],
      stateAndPreparation: null,
      scope: "synthetic capacity fixture",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["ready", "aborted", "unjoined", "failed-status"] as const)(
    "keeps post-failure status on the selected context and admitted lifetime (%s)",
    async (kind) => {
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([recordedRun([])]);
      const failure = new Error("Synthetic status inspection failure");
      const command = vi.spyOn(installedCommand, "run");
      if (kind === "failed-status") {
        command.mockRejectedValue(failure);
      } else {
        command.mockResolvedValue("{}");
      }
      const task = installedTask();
      const controller = new AbortController();
      if (kind === "aborted") {
        controller.abort();
      }
      const commands: installedCommand.CommandRecord[] =
        kind === "unjoined"
          ? [
              {
                args: ["update"],
                launcherPid: 1234,
                beforeCleanup: "indeterminate",
                code: 1,
                signal: null,
                joined: false,
                elapsedMs: 360_000,
              },
            ]
          : [];
      const observations: Record<string, unknown> = {};
      const pending = inspectInstalledUpdateFailure({
        task,
        commands,
        observations,
        signal: controller.signal,
      });
      if (kind === "failed-status") {
        await expect(pending).rejects.toBe(failure);
      } else {
        await pending;
      }
      expect(observations.updateFailure).toMatchObject({ phase: "validating", status: "running" });
      if (kind === "aborted" || kind === "unjoined") {
        expect(command).not.toHaveBeenCalled();
      } else {
        expect(command).toHaveBeenCalledWith(
          [
            task.entry,
            "--profile",
            task.profile,
            "gateway",
            "status",
            "--json",
            "--timeout",
            "5000",
          ],
          task.env,
          task.rootDir,
          commands,
          0,
          controller.signal,
          { observeService: "status" },
        );
      }
    },
  );

  it("reports only new completed steps, never elapsed time, prior runs, or repeated observations", async () => {
    const reader = vi
      .spyOn(updateRunReader, "listUpdateRunsAsync")
      .mockResolvedValue([recordedRun([completedStep], invokedAt - 1)]);
    const fixture = startUpdate();
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.recordProgress).not.toHaveBeenCalled();

    reader.mockResolvedValue([
      recordedRun([
        { step: "global update", status: "in_progress", startedAtMs: invokedAt + 1 },
        { step: "candidate check", status: "completed" },
      ]),
    ]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.recordProgress).not.toHaveBeenCalled();

    reader.mockResolvedValue([recordedRun([completedStep])]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "published-update:completed-step",
    ]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(1);

    // The same named step can legitimately complete again at a later timestamp.
    reader.mockResolvedValue([recordedRun([{ ...completedStep, endedAtMs: invokedAt + 90_000 }])]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(2);
    fixture.command.resolve(JSON.stringify(success));
    await expect(fixture.pending).resolves.toEqual(success);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual([
      "published-update:completed-step",
      "published-update:completed-step",
      "command:update",
    ]);
  });

  it("does not invent progress when the ledger is absent or its read fails", async () => {
    const reader = vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([]);
    const fixture = startUpdate();
    await vi.advanceTimersByTimeAsync(30_000);
    reader.mockRejectedValue(new Error("synthetic unavailable ledger"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    fixture.command.resolve(JSON.stringify(success));
    await expect(fixture.pending).resolves.toEqual(success);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual(["command:update"]);
  });

  it("joins an outstanding ledger read before command completion and stops future observation", async () => {
    const read = createDeferredCore<UpdateRunRecord[]>();
    const reader = vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockReturnValue(read.promise);
    const fixture = startUpdate();
    let settled = false;
    const pending = fixture.pending.then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(reader).toHaveBeenCalled();
    fixture.command.resolve(JSON.stringify(success));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(fixture.recordProgress).not.toHaveBeenCalled();
    read.resolve([]);
    await expect(pending).resolves.toEqual(success);
    const readsAtReturn = reader.mock.calls.length;
    const writesAtReturn = fixture.recordProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reader).toHaveBeenCalledTimes(readsAtReturn);
    expect(fixture.recordProgress).toHaveBeenCalledTimes(writesAtReturn);
    expect(fixture.recordProgress.mock.calls.map(([phase]) => phase)).toEqual(["command:update"]);
  });

  it("joins an outstanding evidence write before recording command completion", async () => {
    vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([
      recordedRun([completedStep]),
    ]);
    const write = createDeferredCore();
    const events: string[] = [];
    const recordProgress = vi.fn(async (phase: string) => {
      if (phase === "published-update:completed-step") {
        events.push("step write started");
        await write.promise;
        events.push("step write completed");
      } else {
        events.push(phase);
      }
    });
    const fixture = startUpdate(recordProgress);
    let settled = false;
    const pending = fixture.pending.then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events).toEqual(["step write started"]);
    fixture.command.resolve(JSON.stringify(success));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(events).toEqual(["step write started"]);
    write.resolve();
    await expect(pending).resolves.toEqual(success);
    expect(events).toEqual(["step write started", "step write completed", "command:update"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual(["step write started", "step write completed", "command:update"]);
  });

  it.each(["command", "observation", "both"] as const)(
    "preserves %s failure instead of reporting successful proof",
    async (failureKind) => {
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([
        recordedRun([completedStep]),
      ]);
      const commandFailure = new Error("synthetic command failed");
      const writeFailure = new Error("synthetic evidence write failed");
      const recordProgress = vi.fn(async (phase: string) => {
        if (phase === "published-update:completed-step" && failureKind !== "command") {
          throw writeFailure;
        }
      });
      const fixture = startUpdate(recordProgress);
      // Attach both handlers before rejection; a rejection must not become an unhandled test error.
      const outcome = fixture.pending.then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(15_000);
      if (failureKind === "observation") {
        fixture.command.resolve(JSON.stringify(success));
      } else {
        fixture.command.reject(commandFailure);
      }
      const { error } = await outcome;
      if (failureKind === "command") {
        expect(error).toBe(commandFailure);
      } else if (failureKind === "observation") {
        expect(error).toBe(writeFailure);
      } else {
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) {
          throw new Error("Both failures must remain available to the proof reporter");
        }
        expect(error.errors).toEqual(expect.arrayContaining([commandFailure, writeFailure]));
      }
    },
  );
});
