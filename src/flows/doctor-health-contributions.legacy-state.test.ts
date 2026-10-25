import { afterEach, expect, it, vi } from "vitest";
import * as terminal from "../../packages/terminal-core/src/note.js";
import * as core from "./doctor-health-contribution-core.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

afterEach(() => vi.restoreAllMocks());

// mock-isolation: Supply only the rescan's reporting fields; no migration writer runs.
vi.mock("../infra/state-migrations.doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/state-migrations.doctor.js")>()),
  detectLegacyStateMigrations: vi.fn(async () => ({
    preview: [],
    warnings: ["prior warning", "new warning"],
    notices: ["prior notice", "new notice"],
  })),
}));

it("reports only new detection notices when legacy state needs another scan", async () => {
  const note = vi.spyOn(terminal, "note").mockImplementation(() => {});
  vi.spyOn(core, "runCoreContributionHealth").mockResolvedValue(undefined);
  const ctx = createDoctorHealthFlowContext({
    configResult: {
      stateMigrationStepReceipts: [
        {
          id: "migration-detection",
          phase: "shared",
          source: [],
          target: [],
          requiredness: "required",
          reversibility: "not-applicable",
          outcome: "skipped",
          changes: [],
          warnings: ["prior warning"],
          notices: ["prior notice"],
        },
      ],
    },
  });

  await resolveDoctorHealthContributions()
    .find((entry) => entry.id === "doctor:legacy-state")!
    .run(ctx);

  expect(note).toHaveBeenCalledWith("new warning", "Doctor warnings");
  expect(note).toHaveBeenCalledWith("new notice", "Doctor notices");
  expect(note).not.toHaveBeenCalledWith(expect.stringContaining("prior"), expect.anything());
});
