import { resolveCronJobConfigRevision } from "../config-revision.js";
import {
  resolveCronJobMessageActionAuthorityInputs,
  resolveCronJobMessageToolAuthorityInputs,
} from "../service/jobs-tool-policy.js";
import type { CronStoredJob } from "../types.js";
import { hasCanonicalCronDeliveryMode } from "./delivery-codec.js";
import { resolveCronJobGrantDefinitionRevision } from "./row-codec.js";
import type { CronReceiptAuthorityJobFacts } from "./run-receipt.types.js";
import type { CronJobGenerationReadRow } from "./schema.js";

/** Keeps receipt, message and standing-grant revisions distinct in published facts. */
export function projectCronReceiptAuthorityJobFacts(
  job: CronStoredJob,
  generationRow?: Pick<
    CronJobGenerationReadRow,
    | "grant_definition_revision"
    | "grant_definition_generation"
    | "grant_definition_updated_at"
    | "updated_at"
  >,
): CronReceiptAuthorityJobFacts {
  return {
    id: job.id,
    agentId: job.agentId,
    sessionKey: job.sessionKey,
    enabled: job.enabled,
    hasCanonicalDeliveryMode: hasCanonicalCronDeliveryMode(job.delivery),
    configRevision: resolveCronJobConfigRevision(job),
    grantDefinitionRevision: resolveCronJobGrantDefinitionRevision(job),
    messageToolAuthorityInputs: resolveCronJobMessageToolAuthorityInputs(job),
    messageActionAuthorityInputs: resolveCronJobMessageActionAuthorityInputs(job),
    ...(generationRow
      ? {
          grantDefinitionProjection: {
            revision: generationRow.grant_definition_revision,
            generation: generationRow.grant_definition_generation,
            updatedAtMs: generationRow.grant_definition_updated_at,
            jobUpdatedAtMs: generationRow.updated_at,
          },
        }
      : {}),
  };
}
