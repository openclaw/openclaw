import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { traceConfigFlowPendingInputs } from "./doctor-config-flow-pending.js";
import type {
  DoctorMaintenancePending,
  DoctorMaintenancePendingCheck,
} from "./doctor-maintenance-pending.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps the config flow at work while inputs without a check remain, after tracing the state plan", async () => {
  // No state database: the schema repair leaves it alone, so its plan answers none.
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("config-flow-pending-") };
  const traced: Array<[string, DoctorMaintenancePending]> = [];
  const trace = async (step: string, check?: DoctorMaintenancePendingCheck) => {
    const pending = check ? await check() : "work";
    traced.push([step, pending]);
    return pending !== "none";
  };

  await traceConfigFlowPendingInputs(trace, { env, integrityCheck: "quick" });

  expect(traced).toEqual([
    ["config-flow.state-schema", "none"],
    ["config-flow", "work"],
  ]);
});
