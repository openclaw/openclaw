import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cronOwnerHardeningEntrypoints } from "../../cron/owner-hardening-runtime.test-support.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { StateDatabaseCoordinatorContentionError } from "../../infra/state-database-coordinator.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import type { UpdateDoctorLintFinding } from "../../infra/update-doctor-lint-schema.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import * as updateRunLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createUpdateProgress } from "./progress.js";
import { captureTargetDatabaseSchemaContext } from "./schema-preflight.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { failUpdateCommandRun } from "./update-command-result.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  createUpdateRunProgress,
  withUpdatePreviewSignals,
} from "./update-command-run.js";
import * as servicePlan from "./update-command-service-plan.js";
import {
  publishUpdateCommandTerminalResult,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { withUpdateCommandRecoveryUnwind } from "./update-command-unwind.js";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});
afterEach(() => vi.mocked(crypto.randomUUID).mockReset());

const sourceImportArgs = resolveRuntimeWorkerUrl(
  updateExecutorNativeEntrypoints.commandRun,
).pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

const dirs = useAutoCleanupTempDirTracker(afterEach);
it.each([
  { kind: "package-post-install-doctor", name: "openclaw doctor", exitCode: 0 },
  { kind: "package-post-install-doctor", name: "openclaw doctor", exitCode: 86 },
  { kind: "recoverable-maintenance", name: "global install swap", exitCode: 0 },
] as const)("persists and surfaces $kind warnings (exit $exitCode)", ({ kind, name, exitCode }) => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-warning-ledger-") };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const message =
    kind === "recoverable-maintenance"
      ? "baseline package fingerprint incomplete after 30 s; rollback will be verified by the retained package copy"
      : "Skipped derived cache cleanup: permission denied. Run openclaw doctor --fix.";
  const otherWarning =
    kind === "recoverable-maintenance"
      ? "Package fingerprint verification unavailable; rollback verified by the retained package copy's directory identity and version."
      : "Skipped legacy cache cleanup: read-only directory. Run openclaw doctor --fix.";
  const result = completeUpdateCommandRun(
    {
      status: "ok",
      mode: "npm",
      durationMs: 1,
      steps: [
        {
          name,
          command: name,
          cwd: "/tmp/update-fixture",
          durationMs: 1,
          exitCode,
          advisory: { kind, message },
          warnings: [message, otherWarning],
        },
      ],
    },
    run,
  );
  expect(result.status).toBe("ok");
  const recorded = getUpdateRun(run.runId, { env });
  expect(recorded).toMatchObject({
    status: "succeeded",
    steps: expect.arrayContaining([
      expect.objectContaining({
        step: `warning:${name}`,
        status: "completed",
        detail: message,
      }),
      expect.objectContaining({
        step: `warning:${name}:2`,
        status: "completed",
        detail: otherWarning,
      }),
    ]),
  });
  expect(recorded && renderUpdateRunReport(recorded).markdown).toContain(message);
  expect(recorded && renderUpdateRunReport(recorded).markdown).toContain(otherWarning);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("persists fingerprint warnings before closing a rolled-back run", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("rollback-fingerprint-warning-") };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const warnings = [
    "baseline package fingerprint incomplete after 30 s; rollback will be verified by the retained package copy",
    "Package fingerprint verification unavailable; rollback verified by the retained package copy's directory identity and version.",
  ];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const result = await publishUpdateCommandTerminalResult(
    { opts: { json: true, run }, ownedManagedUpdateEnv: env },
    {
      status: "error",
      mode: "npm",
      reason: "doctor-failed",
      before: { version: "1.0.0" },
      after: { version: "1.0.0" },
      recovery: {
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        service: "healthy",
        version: "1.0.0",
      },
      durationMs: 50,
      steps: [
        {
          name: "global install rollback",
          command: "restore",
          cwd: env.OPENCLAW_STATE_DIR,
          durationMs: 1,
          exitCode: 0,
          advisory: { kind: "recoverable-maintenance", message: warnings.join("\n") },
          warnings,
        },
      ],
    },
    { rolledBack: true, downtimeMs: 25 },
  );
  expect(result).toMatchObject({ status: "error", reason: "doctor-failed" });
  const recorded = getUpdateRun(run.runId, { env })!;
  expect(recorded).toMatchObject({
    status: "rolled-back",
    reason: "doctor-failed",
    downtimeMs: 25,
  });
  expect(recorded.steps).toEqual(
    expect.arrayContaining(
      warnings.map((detail) => expect.objectContaining({ status: "completed", detail })),
    ),
  );
  for (const warning of warnings) {
    expect(renderUpdateRunReport(recorded).markdown).toContain(warning);
  }
});

it("presents committed steps without reopening the ledger for display", () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("update-progress-committed-") };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  let presentation: ReturnType<typeof createUpdateProgress> | undefined;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  try {
    presentation = createUpdateProgress(true, run);
    const progress = createUpdateRunProgress(run, presentation.progress);
    updateRunLedger.recordUpdateRunPhase(run.runId, "validating", {}, { env });
    const reread = vi.spyOn(updateRunLedger, "getUpdateRun").mockImplementation(() => {
      throw new Error("step presentation must use its committed row");
    });
    try {
      for (const [index, name] of ["fetch", "build", "doctor"].entries()) {
        const step = { name, command: `run ${name}`, index, total: 3 };
        progress.onStepStart?.(step);
        progress.onStepComplete?.({
          ...step,
          durationMs: 1,
          exitCode: name === "fetch" ? 0 : 1,
          ...(name === "build" ? { stdoutTail: "Build type error" } : {}),
          ...(name === "doctor"
            ? {
                advisory: {
                  kind: "package-post-install-doctor" as const,
                  message: "Skipped optional cache cleanup",
                },
                warnings: ["Skipped optional cache cleanup", "Skipped legacy cache cleanup"],
              }
            : {}),
        });
      }
      expect(log).toHaveBeenCalledWith("validating — fetch...");
      expect(log).toHaveBeenCalledWith("validating — build...");
      expect(log.mock.calls.flat().join("\n")).toContain("Build type error");
      expect(log.mock.calls.flat().join("\n")).toContain("Skipped optional cache cleanup");
      expect(
        log.mock.calls
          .flat()
          .filter((line) => typeof line === "string" && line.startsWith("Phase:")),
      ).toEqual(["Phase: requested", "Phase: validating"]);
    } finally {
      reread.mockRestore();
    }
    const recorded = getUpdateRun(run.runId, { env });
    expect(
      recorded?.steps
        .filter((step) => step.step === "fetch" || step.step === "build")
        .map(({ step, status, detail }) => ({ step, status, detail })),
    ).toEqual([
      { step: "fetch", status: "completed", detail: undefined },
      { step: "build", status: "failed", detail: "Exit code: 1; Build type error" },
    ]);
    expect(recorded?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "doctor", status: "completed" }),
        expect.objectContaining({
          step: "warning:doctor",
          status: "completed",
          detail: "Skipped optional cache cleanup",
        }),
        expect.objectContaining({
          step: "warning:doctor:2",
          status: "completed",
          detail: "Skipped legacy cache cleanup",
        }),
      ]),
    );
  } finally {
    try {
      presentation?.dispose();
    } finally {
      if (tty) {
        Object.defineProperty(process.stdout, "isTTY", tty);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }
  }
});
it.each(["state", "config", "include", "environment"])(
  "refuses changed %s ownership after target initialization before writing update history",
  async (changed) => {
    const root = dirs.make("update-initialization-admission-");
    const stateDir = path.join(root, "profile");
    const configPath = path.join(root, "openclaw.json");
    const includePath = path.join(root, "gateway.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("FIXTURE_WORKSPACE_DIR", path.join(root, "workspace"));
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
    vi.spyOn(servicePlan, "isGatewayServiceManagementAllowedForUpdate").mockReturnValue(false);
    fs.writeFileSync(includePath, JSON.stringify({ gateway: { mode: "local" } }));
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        $include: "./gateway.json",
        agents: { defaults: { workspace: "${FIXTURE_WORKSPACE_DIR}" } },
      }),
    );
    const env = { ...process.env };
    const context = await captureTargetDatabaseSchemaContext(env);
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const initialization = {
      env,
      runId: randomUUID(),
      databasePath: resolvePathViaExistingAncestorSync(databasePath),
      configPath: resolvePathViaExistingAncestorSync(configPath),
      target: { configSnapshot: context.configSnapshot },
    };
    if (changed === "state") {
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "replacement-profile"));
    } else if (changed === "config") {
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "replacement.json"));
    } else if (changed === "include") {
      fs.writeFileSync(includePath, JSON.stringify({ gateway: { mode: "local", port: 19222 } }));
    } else {
      vi.stubEnv("FIXTURE_WORKSPACE_DIR", path.join(root, "replacement-workspace"));
    }
    const configBefore = fs.readFileSync(configPath);
    const includeBefore = fs.readFileSync(includePath);

    await expect(
      admitUpdateCommandRun({ opts: {}, root, initialization }).then(() => "admitted"),
    ).rejects.toThrow(/changed/);

    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(process.env))).toBe(false);
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
    expect(fs.readFileSync(includePath)).toEqual(includeBefore);
  },
);

it.each([false, true])(
  "keeps restored-generation completion with its helper across CLI unwind (handoff=%s)",
  (handoff) => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", handoff ? "1" : undefined);
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-rollback-owner-") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const result = {
      status: "error" as const,
      mode: "npm" as const,
      durationMs: 1,
      steps: [],
      reason: "restart-unhealthy",
      before: { version: "2026.9.1" },
      after: { version: "2026.9.1" },
      recovery: {
        serviceRestartSafe: true as const,
        packageRollbackVerified: true as const,
        version: "2026.9.1",
      },
    };
    completeUpdateCommandRun(result, run);
    completeUpdateCommandRun(result, run);
    expect(getUpdateRun(run.runId, { env })).toMatchObject({
      status: handoff ? "running" : "failed",
      after: { version: "2026.9.1" },
    });
    if (handoff) {
      finishUpdateRun(run.runId, { status: "rolled-back", reason: result.reason }, { env });
      completeUpdateCommandRun(result, run);
      expect(getUpdateRun(run.runId, { env })?.status).toBe("rolled-back");
    }
  },
);

function pendingRecovery() {
  const root = dirs.make("update-admission-recovery-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const env = { ...process.env };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
  // This fixture owns every writer of its disposable state directory.
  const record = createRetainedUpdateRecovery(
    { runId: run.runId, from, to: { ...from, version: "2.0.0" } },
    { env },
  );
  closeOpenClawStateDatabaseForTest();
  const snapshot = () =>
    fs
      .readdirSync(root, { recursive: true })
      .map(String)
      .toSorted()
      .map((name) => {
        const filename = path.join(root, name);
        const stat = fs.statSync(filename);
        return {
          name,
          ino: stat.ino,
          mtime: stat.mtimeMs,
          mode: stat.mode,
          sha256: stat.isFile()
            ? createHash("sha256").update(fs.readFileSync(filename)).digest("hex")
            : null,
        };
      });
  return { root, run, record, snapshot };
}

it.each([
  { dryRun: true, reuseRunId: false },
  { dryRun: false, reuseRunId: true },
])(
  "refuses interrupted update admission without touching SQLite ($dryRun, $reuseRunId)",
  async ({ dryRun, reuseRunId }) => {
    const { root, run, record, snapshot } = pendingRecovery();
    if (reuseRunId) {
      vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
    }
    const before = snapshot();
    await expect(
      admitUpdateCommandRun({ opts: { dryRun }, root }).then(() => "admitted"),
    ).rejects.toBeInstanceOf(UpdateRecoveryRequiredError);
    expect(snapshot()).toEqual(before);
    expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
  },
);

it.each(["displaced", "replacement", "both", "unreadable"] as const)(
  "blocks admission when publication has no canonical DB (%s)",
  async (familyState) => {
    const { root, run, snapshot } = pendingRecovery();
    vi.stubEnv(UPDATE_RUN_ID_ENV, run.runId);
    const file = path.join(root, "state", "openclaw.sqlite");
    const family = path.join(path.dirname(file), `.openclaw-restore-${randomUUID()}-0`);
    fs.mkdirSync(family);
    fs.renameSync(file, path.join(family, "displaced"));
    if (familyState === "replacement") {
      fs.renameSync(path.join(family, "displaced"), path.join(family, "replacement"));
    } else if (familyState === "both") {
      fs.copyFileSync(path.join(family, "displaced"), path.join(family, "replacement"));
    } else if (familyState === "unreadable") {
      fs.writeFileSync(path.join(family, "displaced"), "incomplete database");
    }
    const before = snapshot();
    await expect(admitUpdateCommandRun({ opts: {}, root }).then(() => "admitted")).rejects.toThrow(
      "Interrupted shared-database publication is read-only while full-state recovery is deferred",
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(snapshot()).toEqual(before);
  },
);

it.each(["ok", "error"] as const)(
  "does not complete an operationally pending update from diagnostic %s",
  (status) => {
    const { run, record, snapshot } = pendingRecovery();
    const before = snapshot();
    const result = {
      status,
      mode: "npm" as const,
      durationMs: 1,
      steps: [],
      ...(status === "error" ? { reason: "primary-failure" } : {}),
    };
    const completed = completeUpdateCommandRun(result, run);
    expect(completed.status).toBe("error");
    expect(completed.reason).toBe(
      status === "error" ? "primary-failure" : "update-recovery-pending",
    );
    failUpdateCommandRun(new Error("outer unwind"), run);
    expect(snapshot()).toEqual(before);
    expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
    expect(loadUpdateRecovery(run.runId, { env: run.env })).toEqual(record);
  },
);

it.each([false, true])(
  "prints an unexpected update failure after settlement with an existing report (json=%s)",
  async (json) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("update-unexpected-failure-") };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const reportPath = path.join(env.OPENCLAW_STATE_DIR, "update-reports", `${run.runId}.md`);
    let savedAtPublication: string | undefined;
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
      if (String(value).includes("OpenClaw update failed")) {
        savedAtPublication = fs.readFileSync(reportPath, "utf8");
      }
    });
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {
      savedAtPublication = fs.readFileSync(reportPath, "utf8");
    });
    let beforeSettlement: { status?: string; output: number } | undefined;
    await expect(
      withUpdateCommandTerminalResult(
        (registerRun) => {
          registerRun(run);
          return withUpdateCommandRecoveryUnwind(
            { json, run },
            { triageTarget: { env } },
            async () => {
              throw new Error("Candidate validation unexpectedly stopped.");
            },
          ).finally(() => {
            beforeSettlement = {
              status: getUpdateRun(run.runId, { env })?.status,
              output: log.mock.calls.length + output.mock.calls.length,
            };
          });
        },
        { json },
      ),
    ).rejects.toMatchObject({ name: "UpdateCommandFailure" });
    expect(beforeSettlement).toEqual({ status: "running", output: 0 });
    expect(getUpdateRun(run.runId, { env })?.status).toBe("failed");
    expect(savedAtPublication).toContain("Candidate validation unexpectedly stopped.");
    expect(savedAtPublication).toContain("OpenClaw update failed");
    if (json) {
      expect(output).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: "error", runId: run.runId, reportPath }),
      );
      expect(JSON.stringify(output.mock.calls[0]?.[0])).toContain(
        "Candidate validation unexpectedly stopped.",
      );
    } else {
      const text = log.mock.calls.flat().join("\n");
      expect(text).toContain("OpenClaw update failed");
      expect(text).toContain("Candidate validation unexpectedly stopped.");
      expect(text).toContain(`Report: ${reportPath}`);
    }
  },
);

it.each(["ok", "error"] as const)(
  "saves the complete %s diagnostics before printing the Markdown path",
  async (status) => {
    const secret = "sk-synthetic-terminal-" + "x".repeat(48);
    const env = {
      OPENCLAW_STATE_DIR: dirs.make("update-terminal-report-"),
      OPENAI_API_KEY: secret,
    };
    const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const reportPath = path.join(env.OPENCLAW_STATE_DIR, "update-reports", `${run.runId}.md`);
    let savedAtPublication: { markdown: string; failure?: string; inventory?: string } | undefined;
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
      if (String(value) === `Report: ${reportPath}`) {
        const markdown = fs.readFileSync(reportPath, "utf8");
        let failure: string | undefined;
        let inventory: string | undefined;
        if (status === "error") {
          const diagnosticLink = /^Bounded diagnostic JSON: ([^\r\n]+)$/mu.exec(markdown)?.[1];
          if (!diagnosticLink) {
            throw new Error("Published failure report is missing its diagnostic JSON link.");
          }
          failure = fs.readFileSync(path.resolve(path.dirname(reportPath), diagnosticLink), "utf8");
          expect(Buffer.byteLength(failure)).toBeLessThanOrEqual(8 * 1024);
          const inventoryPath = JSON.parse(failure)
            .error.split("Complete Doctor lint inventory: ")[1]
            .split(" Doctor lint receipt: ")[0]
            .replace("$OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
          inventory = fs.readFileSync(inventoryPath, "utf8");
        }
        savedAtPublication = { markdown, ...(failure ? { failure, inventory } : {}) };
      }
    });
    const doctorLintFindings: UpdateDoctorLintFinding[] = Array.from(
      { length: 40 },
      (_, index) => ({
        checkId: `fixture/check-${index}`,
        severity: index === 0 && status === "error" ? "error" : "warning",
        message: `Finding ${index}: ${secret}`,
      }),
    );
    // A valid UUID with a numeric tail must remain a readable diagnostic link.
    vi.mocked(crypto.randomUUID).mockReturnValue("00000000-0000-4000-8000-123456789012");
    await publishUpdateCommandTerminalResult(
      { opts: { run } },
      {
        status,
        mode: "npm",
        reason: status === "error" ? "doctor-failed" : undefined,
        durationMs: 1,
        steps: [
          {
            name: "candidate doctor lint",
            command: "doctor --lint --json",
            cwd: "/fixture",
            durationMs: 1,
            exitCode: status === "error" ? 1 : 0,
            doctorLintFindings,
          },
        ],
      },
      { rolledBack: false },
    );
    expect(log.mock.calls.flat().join("\n")).toContain(`Report: ${reportPath}`);
    expect(savedAtPublication).toBeDefined();
    for (const finding of doctorLintFindings) {
      expect(savedAtPublication?.markdown).toContain(finding.checkId);
      if (status === "error") {
        expect(savedAtPublication?.inventory).toContain(finding.checkId);
      }
    }
    expect(JSON.stringify(savedAtPublication)).not.toContain(secret);
    expect(savedAtPublication?.markdown).toContain(
      status === "error" ? "doctor-failed" : "OpenClaw updated",
    );
  },
);

it("continues normal history admission when no operational update is pending", async () => {
  const root = dirs.make("update-admission-empty-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root });
  expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
});

// Real signals terminate a separate process; the parent never emits into Vitest.
it.skipIf(process.platform === "win32").each([
  { signal: "SIGINT", mode: "fresh" },
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGINT", mode: "resolved" },
  { signal: "SIGTERM", mode: "resolved" },
  { signal: "SIGINT", mode: "resolved-foreign-before" },
  { signal: "SIGINT", mode: "resolved-foreign-after" },
  { signal: "SIGINT", mode: "repeat" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "changed" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "missing" },
] as const)(
  "disposes only the owned unchanged preview before $signal exit ($mode)",
  async ({ signal, mode }) => {
    const root = dirs.make("update-preview-signal-");
    const caller = path.join(root, "preview.mjs");
    fs.writeFileSync(
      caller,
      `
      import fs from 'node:fs';
      import { registerSignalExitGate } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.signalExitBarrier).href)};
      import { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } from ${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)};
      import { createRetainedUpdateRecovery } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.retainedRecovery).href)};
      import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.stateDatabase).href)};
      import { admitUpdateCommandRun, withUpdatePreviewSignals } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandRun).href)};
      import { resolveUpdateCommandTarget } from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandTarget).href)};
      const opts = { dryRun: true };
      const mode = ${JSON.stringify(mode)};
      if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
      const run = await admitUpdateCommandRun({ opts, root: ${JSON.stringify(root)}, installKind: "package" });
      await withUpdatePreviewSignals({ ...opts, run }, async () => {
        const sibling = createUpdateRun({ trigger: 'cli' });
        if (mode.startsWith('resolved')) {
          const foreign = () => recordUpdateRunPhase(run.runId, 'requested', { target: { tag: 'foreign' } });
          if (mode === 'resolved-foreign-before') foreign();
          const root = ${JSON.stringify(root)};
          await resolveUpdateCommandTarget({ ...opts, run }, { triageTarget: { root, env: run.env } }, undefined, {
            startedAt: Date.now(), postCoreUpdateResume: false, postCoreUpdateChannel: undefined,
            timeoutMs: 1000, shouldRestart: false, requestedChannel: null, devTarget: undefined,
            controlPlaneUpdateSentinelMeta: null, discoveredRoot: root, installKind: 'git',
            servicePlan: undefined,
          }, { enter: () => { throw new Error('preview must not acquire a mutable executor'); } }, 1000);
          if (mode === 'resolved-foreign-after') foreign();
        }
        if (mode === 'repeat') {
          registerSignalExitGate(new Promise((resolve) => process.once('message', resolve)));
          process.once('SIGINT', () => process.send('interrupted'));
        }
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'pending' || mode === 'missing') {
          const from = { root: ${JSON.stringify(root)}, nodePath: process.execPath, version: '1.0.0', buildId: null };
          createRetainedUpdateRecovery({ runId: run.runId, from, to: { ...from, version: '2.0.0' } }, { env: run.env });
        }
        if (mode === 'changed') recordUpdateRunPhase(run.runId, 'staging');
        if (mode === 'completed') finishUpdateRun(run.runId, { status: 'skipped', reason: 'dry-run' });
        const expected = getUpdateRun(run.runId);
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          const base = ${JSON.stringify(path.join(root, "state"))};
          const family = base + '/.openclaw-restore-00000000-0000-4000-8000-000000000001-0';
          fs.mkdirSync(family);
          fs.renameSync(base + '/openclaw.sqlite', family + '/displaced');
        }
        process.send({ runId: run.runId, expected, sibling });
        await new Promise(() => setInterval(() => {}, 1000));
      });
    `,
    );
    const child = spawn(process.execPath, [...sourceImportArgs, caller], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_UPDATE_RUN_ID: undefined,
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
        OPENCLAW_UPDATE_POST_CORE: undefined,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(child, "close");
    let releaseGate: ReturnType<typeof setTimeout> | undefined;
    try {
      const message = await Promise.race([
        once(child, "message").then(
          ([payload]) =>
            payload as {
              runId: string;
              expected: ReturnType<typeof getUpdateRun>;
              sibling: ReturnType<typeof createUpdateRun>;
            },
        ),
        closed.then(() => {
          throw new Error(`Preview exited before ready: ${stderr}`);
        }),
      ]);
      const firstSignal = mode === "repeat" ? once(child, "message") : undefined;
      expect(child.kill(signal)).toBe(true);
      if (firstSignal) {
        await firstSignal;
        expect(child.kill(signal)).toBe(true);
        // Hold cleanup across actual repeat-signal delivery; no metadata timeout is involved.
        releaseGate = setTimeout(() => {
          if (child.connected) {
            child.send("release");
          }
        }, 100);
      }
      const [code, exitSignal] = await closed;
      expect(code ?? (exitSignal === "SIGINT" ? 130 : 143)).toBe(signal === "SIGINT" ? 130 : 143);
      const options =
        mode === "missing"
          ? {
              path: path.join(
                root,
                "state",
                ".openclaw-restore-00000000-0000-4000-8000-000000000001-0",
                "displaced",
              ),
            }
          : { env: { OPENCLAW_STATE_DIR: root } };
      const record = getUpdateRun(message.runId, options);
      if (mode.startsWith("resolved")) {
        expect(message.expected).toMatchObject({
          target: { kind: "git", installationMethod: "git-checkout" },
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "installation-inspection", status: "completed" }),
          ]),
        });
      }
      if (mode === "fresh" || mode === "repeat" || mode === "resolved") {
        expect(record).toMatchObject({
          status: "skipped",
          phase: "finished",
          reason: "interrupted",
        });
        expect(record?.finishedAtMs).toEqual(expect.any(Number));
        expect(record?.steps.some((step) => step.status === "in_progress")).toBe(false);
      } else {
        expect(record).toEqual(message.expected);
      }
      expect(getUpdateRun(message.sibling.runId, options)).toEqual(message.sibling);
      if (mode === "missing") {
        for (const suffix of ["", "-wal", "-shm"]) {
          expect(fs.existsSync(path.join(root, "state", `openclaw.sqlite${suffix}`))).toBe(false);
        }
      }
    } finally {
      clearTimeout(releaseGate);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
  60_000,
);

it.each([false, true])(
  "removes preview signal ownership on ordinary unwind (throws=%s)",
  async (throws) => {
    const root = dirs.make("update-preview-cleanup-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
    const run = await admitUpdateCommandRun({ opts: { dryRun: true }, root });
    const before = [process.listeners("SIGINT"), process.listeners("SIGTERM")];
    const operation = withUpdatePreviewSignals({ dryRun: true, run }, async () => {
      if (throws) {
        throw new Error("preview error");
      }
      finishUpdateRun(run.runId, { status: "skipped", reason: "dry-run" }, { env: run.env });
      return 42;
    });
    if (throws) {
      await expect(operation).rejects.toThrow("preview error");
    } else {
      await expect(operation).resolves.toBe(42);
    }
    expect([process.listeners("SIGINT"), process.listeners("SIGTERM")]).toEqual(before);
  },
);

it.each(["in_progress", "completed"] as const)(
  "identifies a progress ledger failure at preflight worktree (%s)",
  (status) => {
    const cause = new StateDatabaseCoordinatorContentionError("state-lifecycle");
    const record = vi.spyOn(updateRunLedger, "recordUpdateRunStep").mockImplementation(() => {
      throw cause;
    });
    const display = { onStepStart: vi.fn(), onStepComplete: vi.fn() };
    const progress = createUpdateRunProgress({ runId: "synthetic-run", env: {} }, display);
    const step = { name: "preflight worktree", command: "git worktree add", index: 1, total: 3 };
    try {
      const invoke = () =>
        status === "in_progress"
          ? progress.onStepStart?.(step)
          : progress.onStepComplete?.({ ...step, durationMs: 1, exitCode: 0 });
      expect(invoke).toThrow(
        `Could not record update step "preflight worktree" (${status}): ${cause.message}`,
      );
      try {
        invoke();
      } catch (error) {
        expect(error).toHaveProperty("cause", cause);
      }
      expect(display.onStepStart).not.toHaveBeenCalled();
      expect(display.onStepComplete).not.toHaveBeenCalled();
    } finally {
      record.mockRestore();
    }
  },
);
