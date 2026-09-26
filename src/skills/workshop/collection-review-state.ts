import path from "node:path";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { SkillExperienceReviewStatus } from "./collection-review.kernel.js";
import { executeSkillWorkshopOperation } from "./store-client.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
export type { SkillExperienceReviewStatus } from "./collection-review.kernel.js";

export async function recordSkillExperienceReviewOutcome(
  agentId: string,
  workspaceDir: string,
  review: SkillExperienceReviewStatus,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    context?: OpenClawStateWorkerContext;
  } = {},
): Promise<void> {
  const input = { agentId, workspaceDir: path.resolve(workspaceDir), review };
  const context = options.context ?? captureOpenClawStateWorkerContext(options);
  return executeSkillWorkshopOperation("workshop.experience.record", input, {
    env: context.environment,
    execution: { context, leases: [] },
  });
}

export function readSkillCollectionBackupDrops(
  agentId: string,
  backupId: string,
  options: SkillWorkshopStoreOptions = {},
) {
  return executeSkillWorkshopOperation("workshop.collection.drops", { agentId, backupId }, options);
}

export function listSkillCollectionReviewOutcomes(
  agentId: string,
  options: SkillWorkshopStoreOptions = {},
) {
  return executeSkillWorkshopOperation("workshop.collection.list", agentId, options);
}
