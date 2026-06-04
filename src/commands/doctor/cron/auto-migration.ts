import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { repairLegacyCronStoreWithoutPrompt, type LegacyCronRepairResult } from "./index.js";

export type CronAutoMigrationResult = LegacyCronRepairResult;

export async function autoMigrateLegacyCronStore(params: {
  cfg: OpenClawConfig;
}): Promise<CronAutoMigrationResult> {
  return await repairLegacyCronStoreWithoutPrompt(params);
}
