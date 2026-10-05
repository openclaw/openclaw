import type { UpgradeRecipeMaintenanceReceipt } from "./maintenance-contract.js";
import type { UpgradeRecipeStepBinding, UpgradeRecipeStepReceipt } from "./receipts-contract.js";
import type { OriginalUpgradeRecipeRun } from "./recovery-contract.js";
import type { RetainedUpgradeRecipeRunPointer } from "./retained-run-contract.js";

export type UpgradeRecipeReadOperations = {
  "upgradeMaintenance.read": { input: undefined; output: UpgradeRecipeMaintenanceReceipt | null };
  "upgradeRecipeSteps.read": {
    input: UpgradeRecipeStepBinding;
    output: UpgradeRecipeStepReceipt | null;
  };
  "upgradeRecipeRuns.read": {
    input: { runId: string };
    output: (OriginalUpgradeRecipeRun & { pointer: RetainedUpgradeRecipeRunPointer }) | null;
  };
};
