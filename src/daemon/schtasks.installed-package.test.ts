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
  parseInstalledUpdateResult,
  runInstalledPublishedUpdate,
  type InstalledTask,
} from "./schtasks.installed-diagnostics.test-support.js";
import * as installedPackage from "./schtasks.installed-package.test-support.js";
import {
  boundedEnv,
  installedStatusSchema,
  resolveInstalledCellBodyTimeoutMs,
  keys,
} from "./schtasks.installed-package.test-support.js";
import * as nativeObservation from "./schtasks.integration-observation.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const candidateCheckNames = [
  "candidate migration rehearsal",
  "candidate doctor lint",
  "candidate config validation",
  "candidate plugin resolution",
  "candidate migration continuation",
  "candidate gateway canary",
];

const secret = "synthetic-installed-credential-do-not-report";
const settledCommand = { signal: null, beforeCleanup: "dead", joined: true };
function completedStep(startedAtMs: number, endedAtMs: number): UpdateRunRecord["steps"][number] {
  return { step: "global update", status: "completed", startedAtMs, endedAtMs };
}
function commandFixture(extraEnv: NodeJS.ProcessEnv = {}) {
  const root = temporary.make("schtasks-installed-command-");
  const records: installedCommand.CommandRecord[] = [];
  const env = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    FIXTURE_SECRET: secret,
    ...extraEnv,
  };
  return {
    records,
    run: (
      script: string,
      options: Parameters<typeof installedCommand.run>[6] = {},
      expectedExit = 0,
    ) => installedCommand.run(["-e", script], env, root, records, expectedExit, undefined, options),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["stdout", "stderr"] as const)(
  "sanitizes colored %s before clipping diagnostics",
  async (stream) => {
    const fixture = commandFixture({ FIXTURE_OUTPUT_STREAM: stream });
    const failure = await fixture
      .run(`
    const output = process.env.FIXTURE_OUTPUT_STREAM === "stderr" ? process.stderr : process.stdout;
    output.write("\\x1b[31m" + JSON.stringify({
      padding: "x".repeat(4000), action: "install", ok: false, token: process.env.FIXTURE_SECRET,
      error: "Synthetic install refusal; inspect the registered task."
    }) + "\\x1b[0m\\n\\x1b[31mtoken\\x1b[0m=" + process.env.FIXTURE_SECRET);
    process.exitCode = 7;
  `)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("Synthetic install refusal");
    expect(String(failure)).not.toContain(secret);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.records[0]).toMatchObject({
      code: 7,
      ...settledCommand,
      failureOutput: { [stream === "stdout" ? "stderr" : "stdout"]: "", captureTruncated: false },
    });
    const output = fixture.records[0]?.failureOutput?.[stream];
    expect(output).toContain('"action":"install"');
    expect(output).toContain("Synthetic install refusal");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("\x1b");
    expect(output?.length).toBeLessThanOrEqual(2002);
  },
);

it("rejects a sibling fence mismatch without revealing credentials or the missing needle", async () => {
  const fixture = commandFixture();
  const missingNeedle = "synthetic-missing-needle-do-not-report";
  const failure = await fixture
    .run(
      `
    process.stdout.write(JSON.stringify({ token: process.env.FIXTURE_SECRET }));
    process.stderr.write("\\x1b[31mpassword\\x1b[0m=" + process.env.FIXTURE_SECRET + "\\nRefusing to rebuild dist: different-fixture");
    process.exitCode = 1;`,
      { expectedStderr: ["Refusing to rebuild dist", missingNeedle, "sibling-fixture"] },
      1,
    )
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).not.toContain(secret);
  expect(String(failure)).not.toContain(missingNeedle);
  expect(String(failure)).not.toContain("\x1b");
  expect(String(failure)).toContain("different-fixture");
  expect(fixture.records[0]).toMatchObject({
    code: 1,
    ...settledCommand,
  });
  expect(fixture.records[0]?.failureOutput?.stdout).not.toContain(secret);
  expect(fixture.records[0]?.failureOutput?.stderr).not.toContain(secret);
  expect(fixture.records[0]?.failureOutput?.stderr).toContain("different-fixture");
});

it("withholds incomplete captures while preserving the truncation failure", async () => {
  const fixture = commandFixture();
  await expect(
    fixture.run(
      'process.stdout.write("x".repeat(262144) + "incomplete-fixture-output"); process.exitCode = 7;',
    ),
  ).rejects.toThrow("Command output was truncated");
  expect(fixture.records).toHaveLength(1);
  expect(fixture.records[0]).toMatchObject({
    code: 7,
    ...settledCommand,
    failureOutput: {
      stdout: "[output withheld: capture limit exceeded]",
      stderr: "[output withheld: capture limit exceeded]",
      captureTruncated: true,
    },
  });
});

it("retains safe native and RPC facts before an exit-zero status fails semantic validation", async () => {
  const fixture = commandFixture({
    FIXTURE_JSON: JSON.stringify({
      service: {
        loaded: true,
        loadState: { status: "loaded" },
        command: { programArguments: ["node", "gateway"], environment: { TOKEN: secret } },
        runtime: {
          status: "unknown",
          detail: "service runtime inspection failed",
          inspectionFailure: {
            code: "service-runtime-inspection-failed",
            detail: "Synthetic Task probe timed out after 10000 ms",
            timeoutMs: 10000,
            token: secret,
          },
        },
      },
      rpc: {
        ok: true,
        server: { version: "2026.9.25", buildId: "fixture-build" },
        auth: { token: secret },
        url: "ws://127.0.0.1:19999",
      },
      gateway: { version: "2026.9.25", port: 19999 },
      port: { status: "busy", port: 19999, listeners: [{ pid: 4321, commandLine: secret }] },
      config: { token: secret },
      models: [secret],
    }),
  });
  const stdout = await fixture.run(
    "process.stdout.write(process.env.FIXTURE_JSON);process.stderr.write(process.env.FIXTURE_SECRET);",
    { observeService: "status", expectedStderr: [secret] },
  );
  expect(() => installedStatusSchema.parse(JSON.parse(stdout))).toThrow();
  expect(fixture.records[0]).toMatchObject({
    code: 0,
    joined: true,
    serviceOutput: {
      kind: "status",
      service: {
        runtime: {
          status: "unknown",
          inspectionFailure: { code: "service-runtime-inspection-failed", timeoutMs: 10000 },
        },
      },
      rpc: { ok: true },
    },
  });
  expect(fixture.records[0]).not.toHaveProperty("failureOutput");
  const observation = JSON.stringify(fixture.records[0]?.serviceOutput);
  for (const excluded of [secret, "environment", "config", "auth", "models"]) {
    expect(observation).not.toContain(excluded);
  }
});

it("retains bounded sanitized install outcome without private response fields", async () => {
  const fixture = commandFixture({
    FIXTURE_JSON: JSON.stringify({
      action: "install",
      ok: true,
      result: "installed",
      message: "Registration completed",
      warnings: Array.from(
        { length: 8 },
        () => "x".repeat(3000) + "\n\u001b[31mtoken\u001b[0m=" + secret,
      ),
      service: { loaded: true, label: "Scheduled Task", environment: { token: secret } },
      definitionBackup: { token: secret },
      config: { token: secret },
      auth: { token: secret },
    }),
  });
  const stdout = await fixture.run("process.stdout.write(process.env.FIXTURE_JSON);", {
    observeService: "install",
  });
  expect(JSON.parse(stdout).ok).toBe(true);
  expect(fixture.records[0]?.serviceOutput).toMatchObject({
    kind: "install",
    action: "install",
    ok: true,
    result: "installed",
    message: "Registration completed",
    service: { loaded: true, label: "Scheduled Task" },
  });
  const observation = JSON.stringify(fixture.records[0]?.serviceOutput);
  for (const excluded of [secret, "\u001b", "definitionBackup", "config", "auth"]) {
    expect(observation).not.toContain(excluded);
  }
  expect(observation.length).toBeLessThan(11_000);
});

it("retains the original failed published result before the bounded output tail", async () => {
  const fixture = commandFixture();
  await expect(
    fixture.run(
      `process.stdout.write(JSON.stringify({
    status: "error", mode: "npm", reason: "primary-update-failure", durationMs: 123,
    root: process.env.FIXTURE_SECRET,
    steps: [{ name: "candidate check", exitCode: 1, durationMs: 12,
      command: process.env.FIXTURE_SECRET, cwd: process.env.FIXTURE_SECRET,
      stderrTail: "token=" + process.env.FIXTURE_SECRET,
      failureFacts: [{ check: "runtime", code: "fixture-failure", message: "Primary check failed", privatePayload: process.env.FIXTURE_SECRET }]
    }], padding: "x".repeat(4000),
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" }
  })); process.exitCode = 1;`,
      { commandBudget: "published-update" },
    ),
  ).rejects.toThrow();
  expect(fixture.records).toHaveLength(1);
  expect(fixture.records[0]).toMatchObject({
    code: 1,
    joined: true,
    publishedUpdate: {
      kind: "published-update",
      status: "error",
      reason: "primary-update-failure",
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [
        {
          name: "candidate check",
          exitCode: 1,
          failureFacts: [
            { check: "runtime", code: "fixture-failure", message: "Primary check failed" },
          ],
        },
      ],
    },
  });
  expect(fixture.records[0]?.failureOutput?.stdout).not.toContain("primary-update-failure");
  for (const excluded of [
    "root",
    "steps.0.command",
    "steps.0.cwd",
    "steps.0.failureFacts.0.privatePayload",
  ]) {
    expect(fixture.records[0]?.publishedUpdate).not.toHaveProperty(excluded);
  }
  expect(JSON.stringify(fixture.records)).not.toContain(secret);
});

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
  const ledger = await import("../infra/update-run-ledger.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../state/openclaw-state-db.js");
  const env = { OPENCLAW_STATE_DIR: temporary.make("installed-update-progress-") };
  const options = { env };
  const privatePayload = "synthetic-private-update-payload";
  try {
    const origin = { nextAction: privatePayload };
    const run = ledger.createUpdateRun({ trigger: "cli", origin }, options);
    const after = { version: "2026.9.6", buildId: "candidate-build", sha: privatePayload };
    ledger.recordUpdateRunPhase(run.runId, "validating", { after }, options);
    const steps: Parameters<typeof ledger.recordUpdateRunStep>[1][] = [
      {
        ...completedStep(100, 200),
        detail: privatePayload,
      },
      {
        step: "warning:managed-service-reconciliation",
        status: "completed",
        detail: "Synthetic native warning; token=synthetic-hidden-credential",
      },
    ];
    for (const step of steps) {
      ledger.recordUpdateRunStep(run.runId, step, options);
    }
    const verification = {
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
    };
    ledger.recordUpdateRunVerification(run.runId, verification, options);
    const before = ledger.getUpdateRun(run.runId, options);
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
    expect(ledger.getUpdateRun(run.runId, options)).toEqual(before);
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
});

it("preserves mixed-case native context while isolating application state", () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  for (const key of Object.keys(process.env)) {
    if (["PATH", "APPDATA", "TEMP", "PSMODULEANALYSISCACHEPATH"].includes(key.toUpperCase())) {
      vi.stubEnv(key, undefined);
    }
  }
  const nativePath = "C:\\native-tools";
  const moduleCache = "C:\\native-cache\\ModuleAnalysisCache";
  vi.stubEnv("Path", nativePath);
  vi.stubEnv("PSModuleAnalysisCachePath", moduleCache);
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
});

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
  const active: UpdateRunRecord = {
    runId: "00000000-0000-0000-0000-000000000000",
    createdAtMs: invokedAt + 1,
    updatedAtMs: invokedAt + 2,
    trigger: "cli",
    phase: "verifying",
    status: "running",
    reason: null,
    origin: {},
    target: {},
    before: {},
    after: {},
    steps: [completedStep(invokedAt + 1, invokedAt + 2)],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: null,
    downtimeMs: null,
  };

  const task: InstalledTask = {
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

  function startUpdate() {
    const recordProgress = vi.fn<(phase: string) => Promise<void>>().mockResolvedValue(undefined);
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
    const phases = () => recordProgress.mock.calls.map(([phase]) => phase);
    return { command, observations, pending, recordProgress, phases };
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

  it.each([false, true])(
    "bounds and sanitizes unfinished update snapshots (native failure=%s)",
    async (failed) => {
      vi.spyOn(updateRunReader, "listUpdateRunsAsync").mockResolvedValue([active]);
      const processFacts = {
        pid: 1234,
        parentPid: 1200,
        createdAt: "2026-09-26T19:40:00.0000000Z",
      };
      const census = vi.spyOn(nativeObservation, "readRelatedProcessDiagnostics").mockReturnValue({
        ok: !failed,
        error: failed ? "observation failed token=" + secret : null,
        truncated: false,
        processes: failed
          ? []
          : [
              {
                ProcessId: processFacts.pid,
                ParentProcessId: processFacts.parentPid,
                CreationDate: processFacts.createdAt,
                CommandLine:
                  'node openclaw.mjs update --token "' + secret + '" ' + "x".repeat(3000),
              },
            ],
      });
      const fixture = startUpdate();
      await vi.advanceTimersByTimeAsync(299_999);
      expect(census).not.toHaveBeenCalled();
      expect(fixture.phases()).toEqual(["published-update:completed-step"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(census).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(census).toHaveBeenCalledTimes(2);
      const diagnostic = failed
        ? { unavailable: expect.stringContaining("observation failed") }
        : { processes: [expect.objectContaining(processFacts)] };
      expect(fixture.observations.updateSettlementProcesses).toMatchObject([
        {
          runId: active.runId,
          capturedAtMs: invokedAt + 300_000,
          phase: "verifying",
          status: "running",
          reason: "elapsed-300s",
          ...diagnostic,
        },
        {
          capturedAtMs: invokedAt + 315_000,
          phase: "verifying",
          status: "running",
          reason: "follow-up",
          ...diagnostic,
        },
      ]);
      const retained = JSON.stringify(fixture.observations.updateSettlementProcesses);
      expect(retained).not.toContain(secret);
      expect(retained.length).toBeLessThan(5000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(census).toHaveBeenCalledTimes(2);
      expect(fixture.recordProgress).toHaveBeenCalledTimes(1);
      fixture.command.resolve(JSON.stringify(success));
      await expect(fixture.pending).resolves.toEqual(success);
      expect(fixture.phases()).toEqual(["published-update:completed-step", "command:update"]);
    },
  );
});
