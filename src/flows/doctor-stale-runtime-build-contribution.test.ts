import { describe, expect, it, vi } from "vitest";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.test-support.js";

const runCoreContributionHealth = vi.fn(
  async (_ctx: DoctorHealthFlowContext, _checkIds: readonly string[]) => {},
);

vi.mock("./doctor-health-contribution-core.js", async (importActual) => ({
  ...(await importActual<typeof import("./doctor-health-contribution-core.js")>()),
  runCoreContributionHealth: (ctx: DoctorHealthFlowContext, checkIds: readonly string[]) =>
    runCoreContributionHealth(ctx, checkIds),
}));

describe("stale runtime build contribution", () => {
  it("runs the core check when doctor is not repairing", async () => {
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:stale-runtime-build",
    );
    expect(contribution).toBeDefined();
    runCoreContributionHealth.mockClear();

    // A plain `openclaw doctor` never enters structured repair, so the
    // contribution itself has to execute the check or it reports nothing.
    await contribution?.run({ prompter: { shouldRepair: false } } as DoctorHealthFlowContext);

    expect(runCoreContributionHealth).toHaveBeenCalledTimes(1);
    expect(runCoreContributionHealth.mock.calls[0]?.[1]).toEqual([
      "core/doctor/stale-runtime-build",
    ]);
  });
});
