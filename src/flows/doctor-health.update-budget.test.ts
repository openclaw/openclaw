import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun, recordUpdateRunPhase } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDoctorHealthContribution,
  recordDoctorHealthWarnings,
} from "./doctor-health-contribution.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

const updateEnv = {
  OPENCLAW_UPDATE_IN_PROGRESS: "1",
  OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
  OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
};
const doctorIds = (names: string) => new Set(names.split(" ").map((name) => `doctor:${name}`));
const repairIds = doctorIds(
  "auth-profiles structured-health-repairs session-transcripts write-config final-config-validation",
);
const repairAnd = (names: string) => new Set([...repairIds, ...doctorIds(names)]);
const deferredChecks = "hooks-model provider-catalog-projection runtime-tool-schemas"
  .split(" ")
  .map((id) => `core/doctor/${id}`);
const updateBudget = (phase: "validation" | "activation" = "activation") => ({
  agentCount: 1,
  phase,
  inspectionDeadlineMs: Date.now() + 149_000,
  source: "activation-policy" as const,
  deferred: new Map(),
});
function selectContributions(...groups: Set<string>[]) {
  const ids = new Set(groups.flatMap((group) => Array.from(group)));
  return resolveDoctorHealthContributions().filter((entry) => ids.has(entry.id));
}
function recordContributions(
  groups: Set<string>[],
  onRun?: (ctx: DoctorHealthFlowContext, id: string) => void,
) {
  const contributions = selectContributions(...groups);
  const executed: string[] = [];
  for (const contribution of contributions) {
    vi.spyOn(contribution, "run").mockImplementation(async (ctx) => {
      executed.push(contribution.id);
      onRun?.(ctx, contribution.id);
    });
  }
  return { contributions, executed };
}

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
  "defers only pure advisory contributions (%s)",
  async (mode) => {
    const env = {
      ...buildUpdateRehearsalPathEnv("/synthetic/rehearsal"),
      ...updateEnv,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
      ...(mode === "partial-markers" ? { HOME: "/synthetic/operator" } : {}),
    };
    const advisoryIds = doctorIds("security runtime-tool-schemas provider-catalog-projection");
    const retainedIds = repairAnd("skills memory-search auth-profile-migration");
    const priorWarnings = Array.from({ length: 31 }, (_, index) => `Repair warning ${index}`);
    const { contributions, executed } = recordContributions(
      [advisoryIds, retainedIds],
      (ctx, id) => {
        if (id === "doctor:write-config") {
          recordDoctorHealthWarnings(ctx, [], ["Final repair warning"]);
        }
      },
    );
    const ctx = createDoctorHealthFlowContext({
      env,
      updateWarnings: priorWarnings,
      updateBudget: updateBudget(mode === "rehearsal" ? "validation" : "activation"),
    });
    await runDoctorHealthContributionList(ctx, contributions);
    expect(new Set(executed)).toEqual(
      mode === "rehearsal" ? retainedIds : new Set([...retainedIds, ...advisoryIds]),
    );
    if (mode === "rehearsal") {
      for (const id of [...advisoryIds, "copied-state rehearsal"]) {
        expect(ctx.runtime.log).toHaveBeenCalledWith(expect.stringContaining(id));
      }
    }
    expect(ctx.updateWarnings).toEqual([...priorWarnings, "Final repair warning"]);
  },
);

it.each([
  { budget: true, marker: "reported-checks", receipt: true },
  { budget: false, marker: "reported-checks", receipt: true },
  { budget: true, marker: undefined, receipt: true },
  { budget: true, marker: "1", receipt: true },
  { budget: true, marker: "reported-checks", receipt: false },
])("defers lint only to an owned post-restart receipt: %j", async ({ budget, marker, receipt }) => {
  const deferredIds = doctorIds("runtime-tool-schemas provider-catalog-projection hooks-model");
  // Security gates readiness; ingress dead letters has no equivalent post-restart lint.
  const retainedIds = repairAnd(
    "session-snapshots workspace-status security channel-ingress-dead-letters",
  );
  const { contributions, executed } = recordContributions([deferredIds, retainedIds]);
  const ctx = createDoctorHealthFlowContext({
    env: {
      ...updateEnv,
      OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS: marker,
    },
    updateBudget: budget ? updateBudget() : undefined,
  });
  const deferred = receipt && marker === "reported-checks";
  if (receipt) {
    await captureUpdateDoctorConfigWrites(ctx.configPath, async (capture) => {
      await runDoctorHealthContributionList(ctx, contributions);
      expect(capture.deferredInspectionCheckIds).toEqual(deferred ? deferredChecks : undefined);
    });
  } else {
    await runDoctorHealthContributionList(ctx, contributions);
  }
  expect(new Set(executed)).toEqual(
    deferred ? retainedIds : new Set([...retainedIds, ...deferredIds]),
  );
  expect(ctx.updateWarnings ?? []).toEqual([]);
  if (deferred) {
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining(deferredChecks.join(", ")),
    );
  }
});

it("records only skips preceding a required failure", async () => {
  const executed: string[] = [];
  const inspection = (id: string) =>
    createDoctorHealthContribution(id, id, {
      updateWork: { kind: "inspection", scope: "run" },
      healthChecks: { description: id, detect: async () => [] },
      run: async () => {
        executed.push(id);
      },
    });
  const contributions = [
    inspection("doctor:newTarget_inspection"),
    createDoctorHealthContribution("doctor:required-inspection", "Required inspection", {
      required: true,
      updateWork: { kind: "inspection", scope: "run" },
      run: async () => {
        throw new Error("Required inspection failed");
      },
    }),
    inspection("doctor:unvisited-inspection"),
  ];
  const ctx = createDoctorHealthFlowContext({
    env: {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS: "reported-checks",
    },
  });
  await captureUpdateDoctorConfigWrites(ctx.configPath, async (capture) => {
    await expect(runDoctorHealthContributionList(ctx, contributions)).rejects.toThrow(
      "Required inspection failed",
    );
    expect(capture.deferredInspectionCheckIds).toEqual(["core/doctor/newTarget_inspection"]);
  });
  expect(executed).toEqual([]);
  expect(ctx.runtime.log).toHaveBeenCalledWith(
    expect.stringContaining("core/doctor/newTarget_inspection"),
  );
});

it.each([
  { agentCount: 480, phase: "validation" },
  { agentCount: 3, phase: "activation" },
])("repairs $agentCount agents during $phase", async ({ agentCount, phase }) => {
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
      ...updateEnv,
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
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
    const selected = selectContributions(
      doctorIds("auth-profiles session-transcripts write-config final-config-validation"),
    );
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
      expect([...(ctx.updateBudget?.deferred.values() ?? [])]).toMatchObject([
        {
          checkId: "core/doctor/auth-profiles",
          severity: "warning",
          errorCode: "update-inspection-deferred",
          requirement: "update-validation-budget",
        },
      ]);
      observed.events = [];
      await runDoctorHealthContributionList(
        createDoctorHealthFlowContext({ cfg, env: {} }),
        selected,
      );
      expect(observed.events).toContain("auth-inspection");
    }
  });
});
