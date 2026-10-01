import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
} from "./doctor-health-contributions.test-support.js";

const mocks = vi.hoisted(() => ({
  runDoctorHealthRepairs: vi.fn(),
}));

vi.mock("./doctor-repair-flow.js", () => ({
  runDoctorHealthRepairs: mocks.runDoctorHealthRepairs,
}));

describe("Doctor health contribution repair evidence", () => {
  beforeEach(() => {
    mocks.runDoctorHealthRepairs.mockReset();
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
    const contribution = createDoctorHealthContribution({
      id: "doctor:test-state-only",
      label: "Test state-only repair",
      healthChecks: {
        description: "Repairs runtime state without changing config",
        detect: vi.fn(async () => []),
      },
    });

    await contribution.run(
      createDoctorHealthFlowContext({
        cfg: {},
        options: { repair: true, externallyManaged: true },
        prompter: createDoctorPrompterFixture(true),
        repairEvidence: {
          applied,
          complete: vi.fn(),
          migration: vi.fn(),
          receipts: vi.fn(),
          remaining: vi.fn(),
        },
      }),
    );

    expect(applied).toHaveBeenCalledWith("doctor:test-state-only", ["Rebuilt the runtime index."]);
  });
});
