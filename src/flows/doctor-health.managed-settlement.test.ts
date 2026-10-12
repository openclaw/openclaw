import { describe } from "vitest";
import { registerDoctorManagedRepairTests } from "./doctor-health.managed.test-support.js";

describe("runDoctorHealthFlow managed repair settlement", () => {
  registerDoctorManagedRepairTests([
    "ready",
    "interactive-ready",
    "interactive-declined",
    "repair-failed",
    "store-close-failed",
    "config-refused",
    "workspace-cleanup-failed",
    "restart-unhealthy",
  ]);
});
