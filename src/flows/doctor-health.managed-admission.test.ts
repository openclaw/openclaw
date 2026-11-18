import { describe } from "vitest";
import { registerDoctorManagedRepairTests } from "./doctor-health.managed.test-support.js";

describe("runDoctorHealthFlow managed service admission", () => {
  registerDoctorManagedRepairTests([
    "archive-verification",
    "clean-stopped-repair",
    "clean-stopped-probe-timeout",
    "clean-stopped-owner-unknown",
    "clean-stopped-manager-unknown",
    "clean-force-repair",
    "clean-force-inspect",
    "update-no-restart",
    "update-no-restart-stopped",
    "update-parent-stopped",
    "update-legacy",
    "ancestor-blocked",
  ]);
});
