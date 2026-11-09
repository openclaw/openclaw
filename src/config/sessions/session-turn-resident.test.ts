import { vi } from "vitest";
import { withActor } from "./session-actor-worker.test-support.js";
import { runSessionTurnResidentTests } from "./session-turn-resident.test-support.js";

// mock-isolation: The fixture owns its database lifetime and transcript ordering.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: Disk-budget maintenance is independent of turn preparation.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

runSessionTurnResidentTests(withActor);
