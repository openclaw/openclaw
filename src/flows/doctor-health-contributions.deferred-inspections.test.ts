import { afterEach, expect, it, vi } from "vitest";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import * as finalContributions from "./doctor-health-contributions-final.js";
import * as initialContributions from "./doctor-health-contributions-initial.js";
import { runDoctorHealthContributions } from "./doctor-health-contributions.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("retains post-activation inspection selectors through retirement-only Doctor", async () => {
  const repair = vi.fn(async () => {});
  const inspect = vi.fn(async () => {});
  const inspection = createDoctorHealthContribution("doctor:test-inspection", "Inspection", {
    updateWork: { kind: "inspection", scope: "run" },
    healthChecks: { description: "Inspection", detect: async () => [] },
    run: inspect,
  });
  vi.spyOn(initialContributions, "resolveInitialDoctorHealthContributions").mockReturnValue([
    createDoctorHealthContribution("doctor:write-config-migrations", "Repair", repair),
    inspection,
  ]);
  vi.spyOn(finalContributions, "resolveFinalDoctorHealthContributions").mockReturnValue([]);
  const ctx = createDoctorHealthFlowContext({
    retirementOnly: true,
    env: {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_UPDATE_PARENT_RUNS_POST_ACTIVATION_INSPECTIONS: "reported-checks",
    },
    configResult: { retirementOnly: true },
  });
  await captureUpdateDoctorConfigWrites(ctx.configPath, async (capture) => {
    await runDoctorHealthContributions(ctx);
    expect(capture.deferredInspectionCheckIds).toEqual(["core/doctor/test-inspection"]);
  });
  expect(repair).toHaveBeenCalledOnce();
  expect(inspect).not.toHaveBeenCalled();
  expect(ctx.retirementOnly).toBe(true);
});
