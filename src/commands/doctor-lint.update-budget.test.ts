import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDoctorUpdateBudget } from "../flows/doctor-update-budget.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { DoctorHealthCheck } from "../flows/health-check-runner-types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { parseReleasedDoctorLintReport } from "../infra/test-fixtures/update-doctor-lint.v2026-9-5.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import {
  createUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { externalDoctorEnv } from "./doctor-update.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const observed = vi.hoisted(() => ({
  now: 0,
  coreChecks: [] as DoctorHealthCheck[],
  reports: 0,
}));
const warning = (checkId: string, fields: object) =>
  expect.objectContaining({ checkId, severity: "warning", ...fields });
const fleetWarning = (): HealthFinding => ({
  checkId: "fixture/fleet-inspection",
  severity: "warning",
  message: "Synthetic optional plugin diagnostic.",
});
vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: async () => observed.coreChecks,
}));
vi.mock("../flows/bundled-health-checks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/bundled-health-checks.js")>();
  const { registerHealthCheck } = await import("../flows/health-check-registry.js");
  return {
    ...actual,
    registerBundledHealthChecks({ cfg }: { cfg: OpenClawConfig }) {
      observed.now += Object.keys(cfg.agents?.entries ?? {}).length * 1_000;
      registerHealthCheck({
        id: "fixture/fleet-inspection",
        kind: "plugin",
        description: "Synthetic fleet inspection",
        detect: async () => [fleetWarning()],
      });
      return [];
    },
  };
});

beforeEach(() => {
  clearHealthChecksForTest();
  Object.assign(observed, { coreChecks: [], reports: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearHealthChecksForTest();
});

async function runLintFixture(
  agentCount: number,
  options: DoctorLintCliOptions = {},
  { snapshotReceipt = false, validationElapsedMs = 20_000 } = {},
) {
  const processTempDir = os.tmpdir();
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          Array.from({ length: agentCount }, (_, index) => [`fleet-${index}`, {}]),
        ),
      },
      plugins: { enabled: false },
    };
    await state.writeConfig(cfg);
    const env = {
      ...state.env,
      ...buildUpdateRehearsalPathEnv(state.stateDir),
      ...externalDoctorEnv(),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
    };
    const startedAt = Date.now();
    const run = createUpdateRun(
      { trigger: "cli", target: { kind: "package" }, before: { version: "2026.9.4" } },
      { env },
    );
    recordUpdateRunPhase(run.runId, "validating", {}, { env });
    if (snapshotReceipt) {
      recordUpdateRunStep(
        run.runId,
        { step: "candidate-state-snapshot", status: "in_progress", startedAtMs: Date.now() },
        { env },
      );
    }
    closeOpenClawStateDatabaseForTest();
    // Emulate the child's rehearsal env without moving the process-lived broker
    // socket into state that this fixture removes after each case.
    vi.spyOn(os, "tmpdir").mockReturnValue(processTempDir);
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(env)) {
      if (value !== process.env[key]) {
        vi.stubEnv(key, value);
      }
    }
    observed.now = startedAt + validationElapsedMs;
    vi.spyOn(Date, "now").mockImplementation(() => observed.now);
    // This lint command's process started one second before it inspects.
    vi.spyOn(performance, "timeOrigin", "get").mockReturnValue(observed.now - 1_000);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      observed.reports += 1;
      return true;
    });
    try {
      const budget = await resolveDoctorUpdateBudget({ cfg, env: process.env });
      const budgetResolvedAt = observed.now;
      const inheritedBudget = snapshotReceipt
        ? await resolveDoctorUpdateBudget({
            cfg,
            env: process.env,
            commandStartedAtMs: observed.now - 5_000,
          })
        : undefined;
      const exitCode = await runDoctorLintCli(createTestRuntime(), {
        json: true,
        severityMin: "error",
        ...options,
      });
      const text = String(stdout.mock.calls.at(-1)?.[0]);
      const report = parseReleasedDoctorLintReport(text);
      return {
        exitCode,
        stdout: text,
        report,
        deferred: report.warnings.filter(
          (finding) => finding.errorCode === "update-inspection-deferred",
        ),
        elapsedMs: observed.now - startedAt,
        budget,
        budgetResolvedAt,
        inheritedBudget,
      };
    } finally {
      stdout.mockRestore();
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  });
}

it.each([3, 480])(
  "keeps published-driver lint within budget and reports deferred work for %i agents",
  async (agentCount) => {
    const result = await runLintFixture(agentCount);
    const { report } = result;
    expect(result, result.stdout).toMatchObject({
      exitCode: 0,
      report: { ok: true, findings: [], checksRun: agentCount === 3 ? 2 : 0 },
    });
    expect(result.elapsedMs).toBeLessThan(298_000);
    expect(report.warnings).toEqual([
      agentCount === 3
        ? fleetWarning()
        : warning("core/doctor/lint-inspection", {
            errorCode: "update-inspection-deferred",
            requirement: "update-validation-budget",
            fixHint: expect.stringContaining("openclaw doctor"),
          }),
    ]);
  },
);

it.each([true, false])(
  "anchors lint after a slow snapshot and Doctor (snapshot receipt: %s)",
  async (snapshotReceipt) => {
    // #170333: snapshot 122s + candidate-doctor 153s before lint started. The
    // copied ledger has no candidate-doctor-lint step; it ends at the snapshot.
    const result = await runLintFixture(3, {}, { snapshotReceipt, validationElapsedMs: 280_000 });
    const { budgetResolvedAt, deferred } = result;
    expect(result, result.stdout).toMatchObject({
      exitCode: 0,
      report: { ok: true, checksRun: snapshotReceipt ? 2 : 0 },
      budget: {
        source: snapshotReceipt ? "validation-command" : "validation-ledger",
      },
    });
    expect(result.budget?.commandStartedAtMs).toBe(
      snapshotReceipt ? budgetResolvedAt - 1_000 : undefined,
    );
    if (snapshotReceipt) {
      expect(result.budget?.disposalDeadlineMs).toBe(budgetResolvedAt + 287_000);
      expect(result.inheritedBudget).toMatchObject({
        commandStartedAtMs: budgetResolvedAt - 5_000,
        disposalDeadlineMs: budgetResolvedAt + 283_000,
      });
      expect(deferred).toEqual([]);
    } else {
      expect(deferred).toEqual([
        warning("core/doctor/lint-inspection", {
          message: expect.stringContaining("(validation-ledger)"),
        }),
      ]);
    }
  },
);

it.each(["selected", "required-error"])(
  "defers optional rehearsal inspection without weakening lint gates (%s)",
  async (mode) => {
    const runtimeCheckId = "core/doctor/runtime-tool-schemas";
    const makeCheck = (
      name: string,
      updateWork?: DoctorHealthCheck["updateWork"],
      defaultEnabled = true,
    ) => ({ id: `core/doctor/${name}`, updateWork, defaultEnabled });
    const optional = [
      makeCheck("runtime-tool-schemas", { kind: "inspection", scope: "agent" }),
      makeCheck("standalone", { kind: "standalone" }),
      makeCheck("opt-in", { kind: "inspection", scope: "run" }, false),
      makeCheck("skipped", { kind: "inspection", scope: "run" }),
    ];
    const required = [
      makeCheck("unclassified"),
      makeCheck("startup", { kind: "startup" }),
      makeCheck("finalize", { kind: "finalize" }),
    ];
    const detected: string[] = [];
    const requiredStarted = createDeferredCore();
    const requiredContinuation = createDeferredCore();
    observed.coreChecks = [...optional, ...required].map((check): DoctorHealthCheck =>
      Object.assign(check, {
        kind: "core",
        description: "Synthetic readiness contract",
        detect: async () => {
          detected.push(check.id);
          if (check.id === "core/doctor/finalize") {
            requiredStarted.resolve();
            await requiredContinuation.promise;
          }
          if (check.id === runtimeCheckId) {
            observed.now += 72_000;
          }
          return mode === "required-error" && check.id === "core/doctor/finalize"
            ? [{ checkId: check.id, severity: "error", message: "Required validation failed." }]
            : [];
        },
      } satisfies Pick<DoctorHealthCheck, "kind" | "description" | "detect">),
    );
    const pendingLint = runLintFixture(8, {
      skipIds: ["core/doctor/skipped"],
      ...(mode === "selected" ? { onlyIds: [runtimeCheckId] } : {}),
    });
    let result: Awaited<ReturnType<typeof runLintFixture>>;
    try {
      if (mode !== "selected") {
        await Promise.race([
          requiredStarted.promise,
          pendingLint.then(() => {
            throw new Error("Lint finished before the required check was admitted.");
          }),
        ]);
        expect(observed.reports).toBe(0);
      }
    } finally {
      requiredContinuation.resolve();
      result = await pendingLint;
    }
    const deferred = mode !== "selected";
    const failed = mode === "required-error";
    expect(detected.toSorted()).toEqual(
      (mode === "selected" ? [runtimeCheckId] : required.map((check) => check.id)).toSorted(),
    );
    expect(result, result.stdout).toMatchObject({
      exitCode: failed ? 1 : 0,
      report: { ok: !failed },
    });
    expect(result.report.findings).toEqual(
      failed
        ? [expect.objectContaining({ checkId: "core/doctor/finalize", severity: "error" })]
        : [],
    );
    expect(result.deferred).toEqual(
      deferred
        ? [runtimeCheckId, "core/doctor/standalone"].map((checkId) =>
            warning(checkId, {
              requirement: "update-validation-scope",
              message: expect.stringContaining("after update activation"),
              fixHint: expect.stringContaining(`--only ${checkId}`),
            }),
          )
        : [],
    );
    if (deferred) {
      expect(JSON.parse(result.stdout)).toMatchObject({
        checksRun: required.length + 2,
        checksSkipped: optional.length,
      });
      expect(result.elapsedMs).toBeLessThan(72_000);
    }
  },
);
