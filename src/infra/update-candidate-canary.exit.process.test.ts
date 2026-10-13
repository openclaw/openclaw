import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { tryListenOnPort } from "./ports-probe.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import { canaryOutcomeStep, renderSteps } from "./update-candidate-canary.test-support.js";
import * as rehearsals from "./update-candidate-rehearsal.js";
import { writeUpdateRunReportArtifact } from "./update-failure-report-artifact.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawStateDatabaseForTest());

it.each([
  "doctor",
  "doctor-signal",
  "policy",
  "missing",
  "failed",
  "failed-exit",
  "signalled-exit",
] as const)(
  "preserves completed checks across a real child exit stall (%s)",
  async (mode) => {
    const root = await fs.realpath(dirs.make("canary-exit-"));
    const stateDir = path.join(root, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir);
    await fs.writeFile(configPath, "{}");
    await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"version":"2026.9.5","type":"module"}');
    await fs.writeFile(
      path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"),
      "console.log(JSON.stringify({state: 2, agent: 3}));",
    );
    await fs.writeFile(
      path.join(root, "dist", "index.js"),
      `import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
if (args.includes("--fix")) {
  if (mode === "doctor-signal") {
    console.log("Doctor complete.");
    writeFileSync(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH, JSON.stringify({
      status: "error", failureFacts: [{check: "plugins", code: "doctor-failed", message: "Plugin repair deferred"}],
    }));
    console.error(Array.from({length: 60}, (_, index) => "earlier warning " + index).join("\\n"));
    console.error("FATAL ERROR: synthetic native failure token=synthetic-secret");
    console.error(Array.from({length: 60}, (_, index) => index + ": node::sqlite::DatabaseSync::Exec(v8::FunctionCallbackInfo<v8::Value> const&) [openclaw]").join("\\n"));
    console.log("adjacent stdout warning\\n".repeat(60));
    process.stderr.write("last native frame", () => process.kill(process.pid, "SIGTERM"));
  } else {
  console.error("└  Doctor complete.");
  if (mode === "doctor") setInterval(() => {}, 1000);
  }
} else if (args.includes("--lint")) {
  if (mode !== "missing") console.log(JSON.stringify({
    ok: mode !== "failed" && mode !== "policy", checksRun: 1,
    findings: mode === "failed" ? [{ checkId: "core/config", message: "Invalid configuration" }]
      : mode === "policy" ? [{ checkId: "core/doctor/security", severity: "error", message: "Policy advisory" }] : [],
    warnings: [{ checkId: "optional/check", severity: "warning", message: "Optional inspection skipped" }],
  }));
  if (mode === "failed-exit" || mode === "signalled-exit") {
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: ["ignore", "inherit", "inherit"],
    }).unref();
    process.stdout.write("", () => {
      if (mode === "signalled-exit") process.kill(process.pid, "SIGTERM");
      else process.exit(7);
    });
  }
  if (mode !== "doctor") setInterval(() => {}, 1000);
} else if (args.includes("plugins")) {
  console.log(JSON.stringify({plugins: [], diagnostics: []}));
} else if (args.includes("gateway")) {
  createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({status: "started", ready: true}));
  }).listen(Number(args.at(-1)), "127.0.0.1");
}
`,
    );
    vi.spyOn(rehearsals, "prepareUpdateCandidateRehearsal").mockResolvedValueOnce({
      stateDir,
      configPath,
      workspaceDir: stateDir,
      port: await tryListenOnPort({ port: 0, host: "127.0.0.1" }),
      env: buildUpdateRehearsalPathEnv(stateDir),
      snapshotCapacity: {
        reason: "explicit-tmpdir",
        sqliteBytes: 0,
        pluginBytes: 0,
        requiredBytes: 0,
        candidates: [],
        selection: { kind: "explicit-tmpdir", directory: stateDir },
      },
      cleanupDirectories: [],
      cleanup: async () => {},
    });
    const options = { env: { OPENCLAW_STATE_DIR: path.join(root, "ledger") } };
    const run = mode === "doctor-signal" ? createUpdateRun({ trigger: "cli" }, options) : undefined;
    const result = await validateUpdateCandidateCanary({
      root,
      config: {},
      stateDir,
      timeoutMs: 2_000,
      onStep: run
        ? (step) => {
            for (const receipt of updateRunStepsFromResultStep(step)) {
              recordUpdateRunStep(run.runId, receipt, options);
            }
          }
        : undefined,
    });
    if (run) {
      for (let index = 0; index < 24; index++) {
        recordUpdateRunStep(
          run.runId,
          { step: `finalize:fixture-${index}`, status: "completed", detail: "detail ".repeat(140) },
          options,
        );
      }
      finishUpdateRun(run.runId, { status: "failed", reason: "doctor-failed" }, options);
      closeOpenClawStateDatabaseForTest();
      const saved = getUpdateRun(run.runId, options)!;
      const crash = saved.steps.find((step) => step.step === "candidate-doctor")!;
      expect(result).toMatchObject({ status: "error", phase: "doctor" });
      expect(crash).toMatchObject({ exitCode: null, termination: "signal", signal: "SIGTERM" });
      expect(crash.failureFacts?.[0]).toMatchObject({ check: "doctor", code: "signal" });
      expect(crash.detail).toContain("Checking data migrations");
      expect(crash.detail).toContain("Doctor complete.");
      expect(crash.stderrTail).toContain("FATAL ERROR: synthetic native failure");
      expect(crash.stderrTail).toContain("0: node::sqlite::DatabaseSync::Exec");
      expect(crash.stderrTail).toContain("last native frame");
      expect(crash.stderrTail?.split("\n").length).toBeLessThanOrEqual(80);
      expect(crash.stderrTail!.length).toBeLessThanOrEqual(8192);
      expect(crash.stderrTail!.length).toBeGreaterThan(4096);
      expect(crash.stderrTail).not.toContain("adjacent stdout");
      expect(JSON.stringify(saved)).not.toContain("synthetic-secret");
      const report = renderUpdateRunReport(saved);
      expect(report.markdown).toContain("SIGTERM");
      expect(report.markdown).toContain("Doctor complete.");
      expect(report.markdown).toContain("Checking data migrations");
      expect(report.markdown).toContain("FATAL ERROR: synthetic native failure");
      expect(report.lines.join("\n")).toContain("last native frame");
      const terminal = renderSteps(result.steps);
      expect(terminal).toContain("SIGTERM");
      expect(terminal).toContain("FATAL ERROR: synthetic native failure");
      expect(terminal).toContain("last native frame");
      const failure = { ...result, mode: "npm" as const, root, runId: run.runId };
      const artifact = await writeUpdateRunReportArtifact({
        result: failure,
        report,
        readRun: () => saved,
        env: options.env,
      });
      const markdown = await fs.readFile(artifact, "utf8");
      expect(markdown).toContain("FATAL ERROR: synthetic native failure");
      expect(markdown).toContain("last native frame");
      expect(markdown).not.toContain("synthetic-secret");
      const publicReport = await prepareUpdateFailureReport(
        { attemptId: run.runId, result: { ...failure, steps: [] }, recordedRun: saved },
        options,
      );
      expect(publicReport.body).toContain("termination signal (SIGTERM)");
      expect(publicReport.body).toContain("candidate-doctor");
      return;
    }
    const failedExit = mode === "failed-exit" || mode === "signalled-exit";
    const step = result.steps.find((candidate) =>
      failedExit ? candidate.name === "candidate-doctor-lint" : candidate.termination === "timeout",
    )!;
    expect(step).toBeDefined();
    const report = renderUpdateRunReport(
      updateRunReportInputFromResult({ ...result, mode: "npm", root }),
    ).markdown;
    if (failedExit) {
      expect(result, report).toMatchObject({ status: "error", phase: "lint" });
      expect(step.exitCode).toBe(mode === "failed-exit" ? 7 : null);
      expect(step.signal).toBe(mode === "signalled-exit" ? "SIGTERM" : null);
      expect(step.failureFacts).toMatchObject([
        { check: "lint", code: mode === "signalled-exit" ? "signal" : "doctor-failed" },
      ]);
      expect(step.advisory).toBeUndefined();
      expect(step.warnings).not.toContainEqual(expect.stringContaining("exit phase"));
    } else if (mode === "missing" || mode === "failed") {
      expect(result).toMatchObject({ status: "error", phase: "lint" });
      expect(step.failureFacts).toMatchObject([
        mode === "failed"
          ? { check: "core/config", message: "Invalid configuration" }
          : { check: "lint", code: "candidate-checks-timeout" },
      ]);
      expect(report).toContain(
        mode === "failed"
          ? "Invalid configuration"
          : "candidate-migration-rehearsal: lint exceeded budget",
      );
    } else {
      expect(result, report).toMatchObject({ status: "ok", phase: "readiness" });
      expect(step.failureFacts).toBeUndefined();
      expect(step.warnings?.join("\n")).toMatch(/exit phase.*\d+ms/u);
      expect(report).toContain("exit phase");
      expect(step.advisory).toMatchObject({ kind: "recoverable-maintenance" });
      if (mode !== "doctor") {
        expect(report).toContain("Optional inspection skipped");
      }
      if (mode === "policy") {
        expect(report).toContain("Policy advisory");
        expect(step.doctorLintFindings).toContainEqual(
          expect.objectContaining({ checkId: "core/doctor/security", severity: "warning" }),
        );
      }
      expect(canaryOutcomeStep(result.steps)).toMatchObject({
        name: "candidate-gateway-startup",
        exitCode: 0,
      });
    }
  },
  15_000,
);
