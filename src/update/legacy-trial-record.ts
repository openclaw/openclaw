import { createHash } from "node:crypto";
import { z } from "zod";

// #204145: main-tracking installs wrote this format before the resident launcher.
// Do not accept modern trials, deferred selection, or an unfinished rollback.
export const legacyTrialSchema = z.object({
  v: z.undefined().optional(),
  runId: z.undefined().optional(),
  phase: z.undefined().optional(),
  outcome: z.undefined().optional(),
  target: z.string().min(1),
  previous: z.string().min(1),
  version: z.string().min(1),
  buildId: z.string().min(1).max(96),
  createdAt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  pending: z.literal(false).optional(),
  restoring: z.undefined().optional(),
});

export type LegacyTrial = z.infer<typeof legacyTrialSchema>;

export type LegacyTrialReceipt = { step: string; version: string; buildId: string };

export function legacyTrialReceipt({
  target,
  previous,
  version,
  buildId,
  createdAt,
}: LegacyTrial): LegacyTrialReceipt {
  // Finalize step keys survive history compaction. The digest keeps paths out of diagnostic text.
  const publication = createHash("sha256")
    .update(JSON.stringify([target, previous, version, buildId, createdAt]))
    .digest("hex");
  return { step: `finalize:legacy-release-prepared:${publication}`, version, buildId };
}
