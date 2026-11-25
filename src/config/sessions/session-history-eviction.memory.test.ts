import { describe, expect, it, vi } from "vitest";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

vi.mock("./disk-budget.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./disk-budget.js")>()),
  measureSessionPhysicalDiskUsage: vi.fn(() => {
    throw new Error("Incognito history was inspected on disk");
  }),
}));

const env = { OPENCLAW_STATE_DIR: "/synthetic/incognito-disk-budget" };
const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
const maintenance = resolveMaintenanceConfigFromInput({
  mode: "enforce",
  maxDiskBytes: 1,
  highWaterBytes: 0,
});

describe("incognito history disk budget", () => {
  it.each([undefined, "main"])(
    "leaves an unbound memory store out of disk cleanup (agentId=%s)",
    async (agentId) => {
      const input = { agentId, storePath, env, mode: "enforce" as const, maintenance };
      await expect(inspectSqliteSessionHistoryDiskBudget(input)).resolves.toEqual({
        diskBudget: null,
        wouldMutate: false,
      });
      await expect(enforceSqliteSessionHistoryDiskBudget(input)).resolves.toBeNull();
      kickSessionHistoryDiskBudgetMaintenance({
        agentId,
        storePath,
        env,
        force: true,
        maintenanceConfig: maintenance,
      });
      expect(measureSessionPhysicalDiskUsage).not.toHaveBeenCalled();
    },
  );
});
