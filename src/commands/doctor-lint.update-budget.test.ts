import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import type { DoctorHealthCheck } from "../flows/health-check-runner-types.js";
import { parseReleasedDoctorLintReport } from "../infra/test-fixtures/update-doctor-lint.v2026-9-5.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun, recordUpdateRunPhase } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const observed = vi.hoisted(() => ({
  now: 0,
  coreChecks: [] as DoctorHealthCheck[],
  runtimePreparations: 0,
  pluginError: false,
  reports: 0,
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshotWithPluginMetadata: async (
      ...args: Parameters<typeof actual.readConfigFileSnapshotWithPluginMetadata>
    ) => {
      observed.runtimePreparations += 1;
      return actual.readConfigFileSnapshotWithPluginMetadata(...args);
    },
  };
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
      // Charge synchronous plugin preparation without delaying the test process.
      observed.now += Object.keys(cfg.agents?.entries ?? {}).length * 1_000;
      registerHealthCheck({
        id: "fixture/fleet-inspection",
        kind: "plugin",
        description: "Synthetic fleet inspection",
        detect: async () => [
          {
            checkId: "fixture/fleet-inspection",
            severity: observed.pluginError ? "error" : "warning",
            message: "Synthetic optional plugin diagnostic.",
          },
        ],
      });
      return [];
    },
  };
});

beforeEach(() => {
  clearHealthChecksForTest();
  observed.coreChecks = [];
  observed.runtimePreparations = 0;
  observed.pluginError = false;
  observed.reports = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearHealthChecksForTest();
});

async function runLintFixture(
  agentCount: number,
  options: DoctorLintCliOptions = {},
  copied = true,
) {
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
      ...(copied ? buildUpdateRehearsalPathEnv(state.stateDir) : {}),
      ...buildUpdateDoctorEnv({
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
        serviceRepairPolicy: "external",
        deferConfiguredPluginInstallRepair: true,
      }),
      OPENCLAW_UPDATE_IN_PROGRESS: "0",
      OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: copied ? "1" : "0",
      OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
      OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: undefined,
    };
    const startedAt = Date.now();
    const run = createUpdateRun(
      { trigger: "cli", target: { kind: "package" }, before: { version: "2026.9.4" } },
      { env },
    );
    recordUpdateRunPhase(run.runId, "validating", {}, { env });
    closeOpenClawStateDatabaseForTest();
    for (const [key, value] of Object.entries(env)) {
      if (value !== process.env[key]) {
        vi.stubEnv(key, value);
      }
    }
    observed.now = startedAt + 20_000;
    vi.spyOn(Date, "now").mockImplementation(() => observed.now);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      observed.reports += 1;
      return true;
    });
    try {
      const exitCode = await runDoctorLintCli(createTestRuntime(), {
        json: true,
        severityMin: "error",
        ...options,
      });
      return {
        exitCode,
        stdout: String(stdout.mock.calls.at(-1)?.[0]),
        elapsedMs: observed.now - startedAt,
      };
    } finally {
      stdout.mockRestore();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
}

it.each([3, 480])(
  "keeps published-driver lint within budget and reports deferred work for %i agents",
  async (agentCount) => {
    const result = await runLintFixture(agentCount);
    const report = parseReleasedDoctorLintReport(result.stdout);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(report).toMatchObject({ ok: true, findings: [] });
    expect(result.elapsedMs).toBeLessThan(298_000);
    expect(report.checksRun).toBe(agentCount === 3 ? 1 : 0);
    expect(report.warnings).toEqual([
      agentCount === 3
        ? {
            checkId: "fixture/fleet-inspection",
            severity: "warning",
            message: "Synthetic optional plugin diagnostic.",
          }
        : expect.objectContaining({
            checkId: "core/doctor/lint-inspection",
            severity: "warning",
            errorCode: "update-inspection-deferred",
            requirement: "update-validation-budget",
            fixHint: expect.stringContaining("openclaw doctor"),
          }),
    ]);
  },
);

it.each(["rehearsal", "standalone", "selected", "required-error", "plugin-error"])(
  "defers optional rehearsal inspection without weakening lint gates (%s)",
  async (mode) => {
    const runtimeCheckId = "core/doctor/runtime-tool-schemas";
    const optional = [
      { id: runtimeCheckId, updateWork: { kind: "inspection", scope: "agent" } },
      { id: "core/doctor/standalone", updateWork: { kind: "standalone" } },
      {
        id: "core/doctor/opt-in",
        updateWork: { kind: "inspection", scope: "run" },
        defaultEnabled: false,
      },
      { id: "core/doctor/skipped", updateWork: { kind: "inspection", scope: "run" } },
    ] satisfies Array<Omit<DoctorHealthCheck, "kind" | "description" | "detect">>;
    const required = [
      { id: "core/doctor/unclassified" },
      { id: "core/doctor/startup", updateWork: { kind: "startup" } },
      { id: "core/doctor/finalize", updateWork: { kind: "finalize" } },
    ] satisfies Array<Omit<DoctorHealthCheck, "kind" | "description" | "detect">>;
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
            // Charge the reported cold inspection cost without a timer or delay.
            observed.now += 72_000;
          }
          return mode === "required-error" && check.id === "core/doctor/finalize"
            ? [{ checkId: check.id, severity: "error", message: "Required validation failed." }]
            : [];
        },
      } satisfies Pick<DoctorHealthCheck, "kind" | "description" | "detect">),
    );
    observed.pluginError = mode === "plugin-error";
    const pendingLint = runLintFixture(
      8,
      {
        skipIds: ["core/doctor/skipped"],
        ...(mode === "selected" ? { onlyIds: [runtimeCheckId] } : {}),
      },
      mode !== "standalone",
    );
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
    expect(observed.reports).toBe(1);
    const report = parseReleasedDoctorLintReport(result.stdout);
    const deferred = mode !== "standalone" && mode !== "selected";
    const failed = mode === "required-error" || mode === "plugin-error";
    expect(result.exitCode, result.stdout).toBe(failed ? 1 : 0);
    expect(report.ok).toBe(!failed);
    expect(observed.runtimePreparations).toBe(deferred ? 0 : 1);
    expect(detected.toSorted()).toEqual(
      (mode === "selected"
        ? [runtimeCheckId]
        : [
            ...required.map((check) => check.id),
            ...(deferred ? [] : [runtimeCheckId, "core/doctor/standalone"]),
          ]
      ).toSorted(),
    );
    expect(report.findings).toEqual(
      failed
        ? [
            expect.objectContaining({
              checkId:
                mode === "required-error" ? "core/doctor/finalize" : "fixture/fleet-inspection",
              severity: "error",
            }),
          ]
        : [],
    );
    expect(
      report.warnings.filter((finding) => finding.errorCode === "update-inspection-deferred"),
    ).toEqual(
      deferred
        ? [runtimeCheckId, "core/doctor/standalone"].map((checkId) =>
            expect.objectContaining({
              checkId,
              severity: "warning",
              requirement: "update-validation-scope",
              message: expect.stringContaining("after update activation"),
              fixHint: expect.stringContaining(`--only ${checkId}`),
            }),
          )
        : [],
    );
    if (deferred) {
      expect(report.checksRun).toBe(required.length + 1);
      expect(JSON.parse(result.stdout).checksSkipped).toBe(optional.length);
      expect(result.elapsedMs).toBeLessThan(72_000);
    }
  },
);
