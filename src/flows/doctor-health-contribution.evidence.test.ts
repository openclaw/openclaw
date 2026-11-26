import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExternallyManagedDoctorRepairEvidence } from "../commands/doctor-externally-managed-repair.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createDoctorHealthContribution,
  recordDoctorHealthWarnings,
} from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";
import { createDoctorCompletedResult } from "./doctor-health-update-result.js";

const mocks = vi.hoisted(() => ({
  runDoctorHealthRepairs: vi.fn(),
  maybeMigrateHeartbeatCadenceToCron: vi.fn(),
}));

vi.mock("./doctor-repair-flow.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-repair-flow.js")>();
  return {
    ...actual,
    runDoctorHealthRepairs: mocks.runDoctorHealthRepairs,
  };
});

vi.mock("../commands/doctor-heartbeat-retirement.js", () => ({
  maybeMigrateHeartbeatCadenceToCron: mocks.maybeMigrateHeartbeatCadenceToCron,
}));

function requireDoctorContribution(id: string) {
  const contribution = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`Missing Doctor contribution: ${id}`);
  }
  return contribution;
}

describe("Doctor health contribution repair evidence", () => {
  beforeEach(async () => {
    await import("./doctor-health-contributions.js");
    mocks.runDoctorHealthRepairs.mockReset();
    mocks.maybeMigrateHeartbeatCadenceToCron.mockReset();
  });

  it("materializes heartbeat cadence before scratch migration and final config writes", async () => {
    const applied = vi.fn();
    const summarize = vi.fn();
    mocks.maybeMigrateHeartbeatCadenceToCron
      .mockResolvedValueOnce({ changes: ["Heartbeat automation committed."], warnings: [] })
      .mockResolvedValueOnce({ changes: [], warnings: ["Heartbeat migration could not finish."] });
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const cadenceIndex = ids.indexOf("doctor:heartbeat-cadence-migration");
    const scratchIndex = ids.indexOf("doctor:heartbeat-scratch-migration");

    expect(cadenceIndex).toBeGreaterThan(-1);
    expect(cadenceIndex).toBeLessThan(scratchIndex);
    expect(scratchIndex).toBeLessThan(ids.indexOf("doctor:write-config"));

    const contribution = requireDoctorContribution("doctor:heartbeat-cadence-migration");
    const source = { agents: { defaults: { heartbeat: { every: "0m" } } } };
    const ctx = createDoctorHealthFlowContext({
      configResult: { heartbeatMigrationSource: source },
      repairEvidence: {
        applied,
        remaining: vi.fn(),
        complete: vi.fn(),
        migration: vi.fn(),
        receipts: vi.fn(),
        summarize,
      },
      prompter: createDoctorPrompterFixture(true),
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });
    await contribution.run(ctx);
    await requireDoctorContribution("doctor:heartbeat-scratch-migration").run(ctx);

    const migration = { cfg: source, shouldRepair: true, env: ctx.env };
    expect(mocks.maybeMigrateHeartbeatCadenceToCron.mock.calls).toEqual([[migration], [migration]]);
    expect(applied).toHaveBeenCalledWith("doctor:heartbeat-retirement", [
      "Heartbeat automation committed.",
    ]);
    expect(summarize).toHaveBeenCalledWith(["Heartbeat migration could not finish."]);
    expect(ctx.updateWarnings).toContain("Heartbeat migration could not finish.");
  });

  it("records state-only structured repairs as applied", async () => {
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      findings: [],
      remainingFindings: [],
      changes: ["Rebuilt the runtime index."],
      warnings: [],
    });
    const applied = vi.fn();
    const contribution = createDoctorHealthContribution(
      "doctor:test-state-only",
      "Test state-only repair",
      {
        healthChecks: {
          description: "Repairs runtime state without changing config",
          detect: vi.fn(async () => []),
        },
      },
    );

    await contribution.run(
      createDoctorHealthFlowContext({
        cfg: {},
        options: { repair: true, externallyManaged: true },
        prompter: createDoctorPrompterFixture(true),
        repairEvidence: {
          applied,
          complete: vi.fn(),
          summarize: vi.fn(),
          migration: vi.fn(),
          receipts: vi.fn(),
          remaining: vi.fn(),
        },
      }),
    );

    expect(applied).toHaveBeenCalledWith("doctor:test-state-only", ["Rebuilt the runtime index."]);
  });
});

it.each([
  "Preserved an unreadable legacy pairing source.",
  `Could not move audit source /${"long-segment/".repeat(60)}: denied.`,
])("keeps owner-classified advisory nonblocking through completion: %s", async (warning) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const evidence = createExternallyManagedDoctorRepairEvidence();
    const receipt = {
      id: "pairing-stores",
      phase: "final",
      source: [],
      target: [],
      requiredness: "conditional",
      reversibility: "checkpoint-required",
      outcome: "warning",
      changes: [],
      warnings: [warning],
    } as const;
    const ctx = createDoctorHealthFlowContext({
      cfg: {},
      options: { repair: true, externallyManaged: true },
      configResult: {
        stateMigrationStepReceipts: [
          { ...receipt, source: [], target: [], changes: [], warnings: [...receipt.warnings] },
        ],
      },
      repairEvidence: evidence.sink,
    });
    evidence.sink.migration(receipt.id, {
      changes: [],
      warnings: [...receipt.warnings],
      warningDisposition: "recoverable",
    });
    evidence.sink.receipts(ctx.configResult.stateMigrationStepReceipts);
    recordDoctorHealthWarnings(ctx, [], [warning]);
    createDoctorCompletedResult(ctx, undefined, []);
    evidence.sink.complete();
    const report = evidence.finish();
    expect(report.ok).toBe(true);
    expect(report.remaining).toEqual([]);
    expect(report.advisories).toEqual([{ stepId: receipt.id, message: receipt.warnings[0] }]);
  });
});
