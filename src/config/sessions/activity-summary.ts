import { z } from "zod";
import type { SessionEntry } from "./types.js";

export const ACTIVITY_SUMMARY_FORMAT_REVISION = 2;

const ActivitySummarySchema = z.object({
  version: z.literal(1),
  formatRevision: z.number().int().positive().optional(),
  text: z.string().max(900),
  updatedAt: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  lifecycleRevision: z.string().optional(),
  generation: z.string().nullable(),
  maxSeq: z.number().int().nullable(),
  leafEntryId: z.string().nullable(),
  coveredMessages: z.number().int().nonnegative(),
  totalMessages: z.number().int().nonnegative(),
  omittedContent: z.boolean(),
});
export type SessionActivitySummary = z.infer<typeof ActivitySummarySchema>;

/** Unknown versions remain reconstructible cache misses, including after downgrade. */
export function readSessionActivitySummary(
  entry: SessionEntry | undefined,
): SessionActivitySummary | undefined {
  const parsed = ActivitySummarySchema.safeParse(entry?.activitySummary);
  if (
    !parsed.success ||
    parsed.data.sessionId !== entry?.sessionId ||
    parsed.data.lifecycleRevision !== entry.lifecycleRevision ||
    parsed.data.coveredMessages > parsed.data.totalMessages
  ) {
    return undefined;
  }
  return parsed.data;
}
