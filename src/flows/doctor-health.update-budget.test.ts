import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun, recordUpdateRunPhase } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

const observed = vi.hoisted(() => ({ now: 0, events: [] as string[] }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("./doctor-auth-health.js", () => ({
  runAuthProfileMigration: async () => {},
  runAuthProfileDiagnostics: async (ctx: { cfg: OpenClawConfig }) => {
    observed.events.push("auth-inspection");
    observed.now += Object.keys(ctx.cfg.agents?.entries ?? {}).length * 1_000;
  },
}));
vi.mock("./doctor-health-contribution-runners.state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-health-contribution-runners.state.js")>()),
  runSessionTranscriptsHealth: async () => {
    observed.events.push("required-session-repair");
    observed.now += 10_000;
  },
}));
vi.mock("./doctor-health-contribution-runners.config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-health-contribution-runners.config.js")>()),
  runWriteConfigHealth: async () => observed.events.push("config-write"),
  runFinalConfigValidationHealth: async () => observed.events.push("final-readiness"),
}));

afterEach(() => vi.restoreAllMocks());

it.each([
  { agentCount: 3, phase: "validation" },
  { agentCount: 480, phase: "validation" },
  { agentCount: 3, phase: "activation" },
  { agentCount: 480, phase: "activation" },
])(
  "completes required repairs and reports deferred inspection for $agentCount agents during $phase",
  async ({ agentCount, phase }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(
            Array.from({ length: agentCount }, (_, index) => [`fleet-${index}`, {}]),
          ),
        },
      };
      const env = {
        ...state.env,
        ...(phase === "validation"
          ? buildUpdateRehearsalPathEnv(state.stateDir)
          : { OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: state.path("doctor-result.json") }),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      };
      const startedAt = Date.now();
      const run = createUpdateRun(
        { trigger: "cli", target: { kind: "package" }, before: { version: "2026.9.4" } },
        { env },
      );
      recordUpdateRunPhase(run.runId, "validating", {}, { env });
      closeOpenClawStateDatabaseForTest();
      // Activation has a fresh inspection window even when validation was long ago.
      const doctorStartedAt = startedAt + (phase === "validation" ? 20_000 : 600_000);
      observed.now = doctorStartedAt;
      observed.events = [];
      vi.spyOn(Date, "now").mockImplementation(() => observed.now);
      const ids = new Set([
        "doctor:auth-profiles",
        "doctor:session-transcripts",
        "doctor:write-config",
        "doctor:final-config-validation",
      ]);
      const selected = resolveDoctorHealthContributions().filter((entry) => ids.has(entry.id));
      expect(selected).toHaveLength(ids.size);
      const priorWarnings = Array.from(
        { length: agentCount === 480 ? 32 : 0 },
        (_, index) => `Prior Doctor warning ${index}`,
      );
      const ctx = createDoctorHealthFlowContext({
        cfg,
        updateWarnings: priorWarnings,
        env,
        preparedAgentCount: agentCount,
        options: { repair: true, nonInteractive: true },
      });
      await runDoctorHealthContributionList(ctx, selected);

      expect(observed.now - doctorStartedAt).toBeLessThan(298_000);
      expect(observed.events).toEqual([
        "required-session-repair",
        ...(agentCount === 3 ? ["auth-inspection"] : []),
        "config-write",
        "final-readiness",
      ]);
      if (agentCount === 3) {
        expect(ctx.updateWarnings ?? []).toEqual([]);
      } else {
        expect(ctx.updateWarnings).toHaveLength(32);
        expect(ctx.updateWarnings).toContain("Prior Doctor warning 0");
        expect(ctx.updateWarnings).toContainEqual(
          expect.stringContaining("core/doctor/auth-profiles [update-inspection-deferred]"),
        );
        expect([...(ctx.updateBudget?.deferred.values() ?? [])]).toEqual([
          expect.objectContaining({
            checkId: "core/doctor/auth-profiles",
            severity: "warning",
            errorCode: "update-inspection-deferred",
            requirement: "update-validation-budget",
          }),
        ]);
        observed.events = [];
        await runDoctorHealthContributionList(
          createDoctorHealthFlowContext({ cfg, env: {} }),
          selected,
        );
        expect(observed.events).toContain("auth-inspection");
      }
    });
  },
);
