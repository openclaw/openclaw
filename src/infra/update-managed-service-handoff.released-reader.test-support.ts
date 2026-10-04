// Frozen v2026.9.8 strict reader projection for ordinary v2 update children.
import { z } from "zod";

const text = z.string().min(1).max(4096);
const processIdentity = z.strictObject({
  pid: z.number().int().positive(),
  startIdentity: text.max(128),
  startIdentitySource: z.literal("argv-sha256").nullable().optional(),
});

const releasedCommandLease = z.strictObject({
  version: z.literal(2),
  executor: processIdentity,
  helper: processIdentity,
  action: z.strictObject({
    kind: z.literal("update"),
    mutationProtocol: z.literal("original-cancellation-v1").optional(),
  }),
});

export function parseReleasedCommandLease(value: string) {
  return releasedCommandLease.parse(JSON.parse(value));
}
