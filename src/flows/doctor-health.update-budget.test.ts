import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun, recordUpdateRunPhase } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recordDoctorHealthWarnings } from "./doctor-health-contribution.js";
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

it.each(["rehearsal", "partial-markers"])(
  "defers only pure advisory contributions during %s and records their IDs",
  async (mode) => {
    const env = {
      ...(mode === "rehearsal" || mode === "partial-markers"
        ? buildUpdateRehearsalPathEnv("/synthetic/rehearsal")
        : {}),
      ...(mode !== "standalone"
        ? {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_SERVICE_REPAIR_POLICY: "external",
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          }
        : {}),
      ...(mode === "partial-markers" ? { HOME: "/synthetic/operator" } : {}),
    };
    const advisoryIds = new Set([
      "doctor:security",
      "doctor:runtime-tool-schemas",
      "doctor:provider-catalog-projection",
    ]);
    const retainedIds = new Set([
      "doctor:auth-profiles",
      "doctor:structured-health-repairs",
      "doctor:skills",
      "doctor:memory-search",
      "doctor:session-transcripts",
      "doctor:auth-profile-migration",
      "doctor:write-config",
      "doctor:final-config-validation",
    ]);
    const contributions = resolveDoctorHealthContributions().filter(
      (entry) => advisoryIds.has(entry.id) || retainedIds.has(entry.id),
    );
    expect(contributions).toHaveLength(advisoryIds.size + retainedIds.size);
    const executed: string[] = [];
    const priorWarnings = Array.from({ length: 31 }, (_, index) => `Repair warning ${index}`);
    for (const contribution of contributions) {
      vi.spyOn(contribution, "run").mockImplementation(async (ctx) => {
        executed.push(contribution.id);
        if (contribution.id === "doctor:write-config") {
          recordDoctorHealthWarnings(ctx, [], ["Final repair warning"]);
        }
      });
    }
    const ctx = createDoctorHealthFlowContext({
      env,
      updateWarnings: priorWarnings,
      updateBudget: {
        agentCount: 1,
        phase: mode === "rehearsal" ? "validation" : "activation",
        inspectionDeadlineMs: Date.now() + 149_000,
        source: "activation-policy",
        deferred: new Map(),
      },
    });
    await runDoctorHealthContributionList(ctx, contributions);
    expect(new Set(executed)).toEqual(
      mode === "rehearsal" ? retainedIds : new Set([...retainedIds, ...advisoryIds]),
    );
    if (mode === "rehearsal") {
      for (const id of advisoryIds) {
        expect(ctx.runtime.log).toHaveBeenCalledWith(expect.stringContaining(id));
      }
      expect(ctx.runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("copied-state rehearsal"),
      );
    }
    expect(ctx.updateWarnings).toEqual([...priorWarnings, "Final repair warning"]);
  },
);

it.each([true, false])(
  "defers lint-backed advisory inspections from an updater that runs them after restart (budget=%s)",
  async (hasBudget) => {
    const deferredIds = new Set([
      "doctor:runtime-tool-schemas",
      "doctor:provider-catalog-projection",
      "doctor:hooks-model",
    ]);
    const retainedIds = new Set([
      "doctor:session-snapshots",
      "doctor:workspace-status",
      // Readiness lint gates on its security check; it stays before restart.
      "doctor:security",
      // No lint check can reproduce this after restart.
      "doctor:channel-ingress-dead-letters",
      "doctor:auth-profiles",
      "doctor:structured-health-repairs",
      "doctor:session-transcripts",
      "doctor:write-config",
      "doctor:final-config-validation",
    ]);
    const contributions = resolveDoctorHealthContributions().filter(
      (entry) => deferredIds.has(entry.id) || retainedIds.has(entry.id),
    );
    expect(contributions).toHaveLength(deferredIds.size + retainedIds.size);
    const executed: string[] = [];
    for (const contribution of contributions) {
      vi.spyOn(contribution, "run").mockImplementation(async () => {
        executed.push(contribution.id);
      });
    }
    const updateBudget = () => ({
      agentCount: 1,
      phase: "activation" as const,
      inspectionDeadlineMs: Date.now() + 149_000,
      source: "activation-policy" as const,
      deferred: new Map(),
    });
    const updateEnv = {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    };
    const ctx = createDoctorHealthFlowContext({
      env: { ...updateEnv, OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS: "1" },
      updateBudget: hasBudget ? updateBudget() : undefined,
    });
    await runDoctorHealthContributionList(ctx, contributions);

    expect(new Set(executed)).toEqual(retainedIds);
    expect(ctx.updateWarnings ?? []).toEqual([]);
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Deferred advisory inspections until the restarted Gateway is ready: doctor:hooks-model, doctor:provider-catalog-projection, doctor:runtime-tool-schemas.",
      ),
    );

    // A shipped updater never runs them after restart, so its Doctor keeps them.
    executed.length = 0;
    await runDoctorHealthContributionList(
      createDoctorHealthFlowContext({
        env: updateEnv,
        updateBudget: hasBudget ? updateBudget() : undefined,
      }),
      contributions,
    );
    expect(new Set(executed)).toEqual(new Set([...retainedIds, ...deferredIds]));
  },
);

it.each([
  { agentCount: 480, phase: "validation" },
  { agentCount: 3, phase: "activation" },
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
