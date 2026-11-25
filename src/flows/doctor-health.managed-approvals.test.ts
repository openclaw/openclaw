import { describe } from "vitest";
import { registerDoctorManagedRepairTests } from "./doctor-health.managed.test-support.js";

describe("runDoctorHealthFlow managed approval migration", () => {
  registerDoctorManagedRepairTests([
    "approvals-malformed",
    "approvals-conflicting",
    "approvals-migrated",
  ]);
});
