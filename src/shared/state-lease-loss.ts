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
