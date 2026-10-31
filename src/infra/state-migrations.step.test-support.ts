import type { LegacyStateMigrationStepPlan } from "./state-migrations.types.js";

export function migrationStepInput(
  id: string,
  requiredness: LegacyStateMigrationStepPlan["requiredness"],
  reversibility: LegacyStateMigrationStepPlan["reversibility"],
): Omit<LegacyStateMigrationStepPlan, "outcome"> {
  return { id, phase: "shared", source: [], target: [], requiredness, reversibility };
}
