import { z } from "zod";

const milliseconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const StateLeaseLossSchema = z.discriminatedUnion("reason", [
  z.object({
    reason: z.literal("expired"),
    expiresAt: milliseconds,
    expiredByMs: milliseconds,
    heartbeatAgeMs: milliseconds,
    renewalTimerLateByMs: milliseconds.optional(),
  }),
  z.object({ reason: z.literal("replaced"), owner: z.literal("[redacted]") }),
  z.object({ reason: z.literal("missing") }),
]);

export type StateLeaseLoss = z.infer<typeof StateLeaseLossSchema>;

export function formatStateLeaseLoss(loss: StateLeaseLoss): string {
  if (loss.reason === "expired") {
    return `lease loss: expired; expiredByMs=${loss.expiredByMs}; expiresAt=${loss.expiresAt}; heartbeatAgeMs=${loss.heartbeatAgeMs}${loss.renewalTimerLateByMs === undefined ? "" : `; renewal timer late ${loss.renewalTimerLateByMs} ms`}`;
  }
  return loss.reason === "replaced"
    ? "lease loss: replaced; owner=[redacted]"
    : "lease loss: missing";
}
