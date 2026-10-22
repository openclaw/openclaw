import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  canaryOutcomeStep,
  createCanaryProcessFixture,
  renderSteps,
} from "./update-candidate-canary.test-support.js";
import * as rehearsals from "./update-candidate-rehearsal.js";
import { writeUpdateRunReportArtifact } from "./update-failure-report-artifact.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import * as ledger from "./update-run-ledger.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawStateDatabaseForTest());

function contains(text: string | undefined, ...parts: string[]) {
  parts.forEach((part) => expect(text).toContain(part));
}

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
    const rehearsal = await createCanaryProcessFixture(
      root,
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
    const { stateDir } = rehearsal;
    vi.spyOn(rehearsals, "prepareUpdateCandidateRehearsal").mockResolvedValueOnce(rehearsal);
    const options = { env: { OPENCLAW_STATE_DIR: path.join(root, "ledger") } };
    const run =
      mode === "doctor-signal" ? ledger.createUpdateRun({ trigger: "cli" }, options) : undefined;
    const result = await validateUpdateCandidateCanary({
      root,
      config: {},
      stateDir,
      timeoutMs: 2_000,
      onStep: run
        ? (step) => {
            for (const receipt of updateRunStepsFromResultStep(step)) {
              ledger.recordUpdateRunStep(run.runId, receipt, options);
            }
          }
        : undefined,
    });
    if (run) {
      for (let index = 0; index < 24; index++) {
        ledger.recordUpdateRunStep(
          run.runId,
          { step: `finalize:fixture-${index}`, status: "completed", detail: "detail ".repeat(140) },
          options,
        );
      }
      ledger.finishUpdateRun(run.runId, { status: "failed", reason: "doctor-failed" }, options);
      closeOpenClawStateDatabaseForTest();
      const saved = ledger.getUpdateRun(run.runId, options)!;
      const crash = saved.steps.find((step) => step.step === "candidate-doctor")!;
      expect(result).toMatchObject({ status: "error", phase: "doctor" });
      expect(crash).toMatchObject({ exitCode: null, termination: "signal", signal: "SIGTERM" });
      expect(crash.failureFacts?.[0]).toMatchObject({ check: "doctor", code: "signal" });
      contains(crash.detail, "Checking data migrations", "Doctor complete.");
      const fatal = "FATAL ERROR: synthetic native failure";
      const finalFrame = "last native frame";
      contains(crash.stderrTail, fatal, "0: node::sqlite::DatabaseSync::Exec", finalFrame);
      expect(crash.stderrTail?.split("\n").length).toBeLessThanOrEqual(80);
      expect(crash.stderrTail!.length).toBeLessThanOrEqual(8192);
      expect(crash.stderrTail!.length).toBeGreaterThan(4096);
      expect(crash.stderrTail).not.toContain("adjacent stdout");
      expect(JSON.stringify(saved)).not.toContain("synthetic-secret");
      const report = renderUpdateRunReport(saved);
      contains(report.markdown, "SIGTERM", "Doctor complete.", "Checking data migrations", fatal);
      contains(report.lines.join("\n"), finalFrame);
      contains(renderSteps(result.steps), "SIGTERM", fatal, finalFrame);
      const failure = { ...result, mode: "npm" as const, root, runId: run.runId };
      const artifact = await writeUpdateRunReportArtifact({
        result: failure,
        report,
        readRun: () => saved,
        env: options.env,
      });
      const markdown = await fs.readFile(artifact, "utf8");
      contains(markdown, fatal, finalFrame);
      expect(markdown).not.toContain("synthetic-secret");
      const publicReport = await prepareUpdateFailureReport(
        { attemptId: run.runId, result: { ...failure, steps: [] }, recordedRun: saved },
        options,
      );
      contains(publicReport.body, "termination signal (SIGTERM)", "candidate-doctor");
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
it.each([
  [
    "OpenClaw state database schema migration required (audit-events-v2) at /home/private-owner/state.sqlite; run openclaw doctor --fix to migrate it.",
    "schema migration required",
  ],
  [
    "[openclaw] Reason: plugin load failed: discord: private-tenant at /home/private-owner/plugin.ts",
    "plugin load failed: discord",
  ],
  ["plugin load failed: private-tenant: private-host.example", "plugin load failed"],
  [
    "[plugins] discord failed during load from /home/private-owner/plugin.ts: private-tenant",
    "plugin load failed: discord",
  ],
  ["gateway requires offline media migration. private-tenant", "schema migration required"],
  [
    "Gateway refused startup because 1 OpenClaw database schema(s) are newer than this build. private-tenant",
    "database schema newer than candidate",
  ],
  ["another gateway instance is already listening on ws://10.20.30.40:18789", "port in use"],
  ["Cannot find module '/home/private-owner/native.node'", "native module missing"],
  [
    "The module '/home/private-owner/native.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127.",
    "native module ABI mismatch",
  ],
  [
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "startup ran out of memory",
  ],
  ["Invalid config at /home/private-owner/openclaw.json:", "Invalid configuration field"],
  [
    "Invalid config at /home/private-owner/openclaw.json:\n- private-config.json:12 — agents.entries.private-agent.model.primary: Invalid input: expected string, received number",
    "Invalid configuration field; agents.entries.<id>.model.primary: expected string, got number",
  ],
  ["private-tenant startup failed at private-host.example", "[redacted-diagnostic]"],
  ["unterminated", "plugin load failed: discord"],
  ["signal", "startup crash with signal SIGTERM"],
  ["timeout", "readiness timeout"],
] as const)("reports the closed startup cause for %s", async (diagnostic, expected) => {
  const root = await fs.realpath(dirs.make("canary-public-cause-"));
  const rehearsal = await createCanaryProcessFixture(
    root,
    `
const args = process.argv.slice(2);
if (args.includes("--fix")) console.log("Doctor complete.");
else if (args.includes("--lint")) console.log(JSON.stringify({ok:true, checksRun:1, findings:[], warnings:[]}));
else if (args.includes("plugins")) console.log(JSON.stringify({plugins:[], diagnostics:[]}));
else if (args.includes("gateway")) {
  if (${JSON.stringify(diagnostic)} === "unterminated") {
    process.stderr.write("plugin load failed: discord: private-tenant");
    process.exitCode = 1;
  } else if (${JSON.stringify(diagnostic)} === "timeout") {
    console.error("openclaw-update-canary-progress: entry.bootstrap");
    setInterval(() => {}, 1000);
  } else {
  console.error("private-tenant warning token=synthetic-private-token at private-host.example");
  console.error(${JSON.stringify(diagnostic)});
  console.error("private stack frame at /home/private-owner/plugin.ts\\n".repeat(90));
  if (${JSON.stringify(diagnostic)} === "signal") process.stderr.write("", () => process.kill(process.pid, "SIGTERM"));
  else
  process.exitCode = 1;
  }
}
`,
  );
  const { stateDir } = rehearsal;
  vi.spyOn(rehearsals, "prepareUpdateCandidateRehearsal").mockResolvedValueOnce(rehearsal);
  const result = await validateUpdateCandidateCanary({
    root,
    config: {},
    stateDir,
    timeoutMs: diagnostic === "timeout" ? 1000 : 5000,
  });
  expect(result.status).toBe("error");
  const report = await prepareUpdateFailureReport(
    {
      attemptId: "startup-cause",
      result: { ...result, mode: "npm" },
    },
    { env: {}, stateDir },
  );
  if (expected === "[redacted-diagnostic]") {
    expect(report.body).toContain(
      "Failing check startupz (candidate-startup-failed): [redacted-diagnostic]",
    );
  } else {
    expect(report.body).toContain(
      `Failed phase candidate-gateway-startup: ${diagnostic === "signal" || diagnostic === "timeout" ? expected : `exit 1 (${expected})`}`,
    );
  }
  expect(report.body).not.toMatch(
    /private-tenant|private-owner|private-host|private-config|private-agent|10\.20\.30\.40|synthetic-private-token|\/home\//u,
  );
});
