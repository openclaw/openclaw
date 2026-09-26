import "./update-command-execution.test-support.js";
import { expect, it, vi } from "vitest";
import * as repairAgent from "../../infra/update-repair-agent.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { executeMutableUpdate } from "./update-command-execution.js";

const { executionParams, mocks, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

it("returns failed candidate checks without starting inference or repeating rehearsal", async () => {
  await withOpenClawTestState({}, async (state) => {
    await state.writeConfig({});
    const repair = vi
      .spyOn(repairAgent, "runUpdateRepairLoop")
      .mockRejectedValue(new Error("Inference is unavailable."));
    const step = {
      name: "candidate-doctor",
      command: "doctor --fix",
      cwd: "/candidate",
      durationMs: 1,
      exitCode: 1,
      failureFacts: [{ check: "state", code: "doctor-failed", message: "State is unreadable." }],
    };
    mocks.validateCanary.mockResolvedValue({
      status: "error",
      reason: "doctor-failed",
      phase: "doctor",
      durationMs: 1,
      steps: [step],
      logTail: ["State is unreadable."],
    });
    mocks.runPackageUpdate.mockImplementation(async ({ validateCandidate }) => {
      const steps = await validateCandidate("/candidate");
      return { ...successfulUpdate, status: "error", steps };
    });

    const execution = await executeMutableUpdate(executionParams("package"));

    expect(execution?.result).toMatchObject({
      status: "error",
      reason: "doctor-failed",
      steps: [step],
    });
    expect(mocks.validateCanary).toHaveBeenCalledOnce();
    expect(repair).not.toHaveBeenCalled();
    expect(mocks.serviceStopped).toBe(false);
  });
});
