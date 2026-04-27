import { getMigrationProvider } from "./registry.js";
import type { MigrationPlan, MigrationPlanOptions } from "./types.js";

export async function buildMigrationPlan(options: MigrationPlanOptions): Promise<MigrationPlan> {
  return await getMigrationProvider(options.providerId).plan(options);
}
