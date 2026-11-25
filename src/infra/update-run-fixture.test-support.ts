import { readUpdateRunDriver } from "./update-run-driver.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  getUpdateRunAsync,
  recordUpdateRunDiagnostics,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";

export function deadDriverFixture() {
  const driver = readUpdateRunDriver();
  if (!driver) {
    throw new Error("The fixture requires its native process identity");
  }
  return { driver, dead: { ...driver, startIdentity: driver.startIdentity === "0" ? "1" : "0" } };
}

export function updateRunFixture(
  options: NonNullable<Parameters<typeof createUpdateRun>[1]>,
  input: Parameters<typeof createUpdateRun>[0] = { trigger: "cli" },
) {
  const id = createUpdateRun(input, options).runId;
  return {
    id,
    options,
    read: () => getUpdateRun(id, options),
    readAsync: () => getUpdateRunAsync(id, options),
    step: (value: Parameters<typeof recordUpdateRunStep>[1]) =>
      recordUpdateRunStep(id, value, options),
    phase: (value: Parameters<typeof recordUpdateRunPhase>[1]) =>
      recordUpdateRunPhase(id, value, {}, options),
    verify: (value: Parameters<typeof recordUpdateRunVerification>[1]) =>
      recordUpdateRunVerification(id, value, options),
    finish: (value: Parameters<typeof finishUpdateRun>[1]) => finishUpdateRun(id, value, options),
    record: (
      value: Parameters<typeof recordUpdateRunDiagnostics>[1],
      warn: (message: string) => void = () => {
        throw new Error("diagnostics were not recorded");
      },
    ) => recordUpdateRunDiagnostics(id, value, warn, options),
  };
}

export function interruptedRunFixture(
  options: Parameters<typeof updateRunFixture>[0],
  candidate: { version: string; buildId: string },
  managed = false,
) {
  const { dead: driver } = deadDriverFixture();
  const fixture = updateRunFixture(options, { trigger: "cli", origin: { driver } });
  fixture.step({
    step: "finalize:installed-candidate",
    status: "completed",
    detail: JSON.stringify(candidate),
  });
  if (managed) {
    fixture.step({ step: "restarting", status: "completed" });
  }
  fixture.step({ step: "post-update verification", status: "completed" });
  fixture.phase("verifying");
  return { ...fixture, driver };
}
