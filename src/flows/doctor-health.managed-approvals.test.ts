import { describe } from "vitest";
import { registerDoctorManagedRepairTests } from "./doctor-health.managed.test-support.js";

describe("runDoctorHealthFlow managed approval migration", () => {
  registerDoctorManagedRepairTests([
    "approvals-malformed",
    "approvals-malformed-canonical",
    "approvals-conflicting",
    "approvals-migrated",
  ]);
});
