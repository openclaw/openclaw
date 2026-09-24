import { describe } from "vitest";
import { registerDoctorManagedRepairTests } from "./doctor-health.managed.test-support.js";

describe("runDoctorHealthFlow managed service admission", () => {
  registerDoctorManagedRepairTests([
    "clean-repair",
    "clean-inspect",
    "clean-force-repair",
    "clean-force-inspect",
    "update-no-restart",
    "update-no-restart-stopped",
    "update-parent-stopped",
    "update-legacy",
    "ancestor-blocked",
  ]);
});
