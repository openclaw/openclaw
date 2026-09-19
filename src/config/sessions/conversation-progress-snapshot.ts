import { z } from "zod";
import type { ChannelProgressDraftCompositorSnapshot } from "../../channels/progress-draft-compositor.types.js";

const MAX_SNAPSHOT_BYTES = 64 * 1024;
const text = z.string().max(4096);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Persist prepared display fields only, never the compositor's private buffers,
// callbacks, transport credentials, or arbitrary plugin payloads.
const snapshotSchema = z.strictObject({
  lines: z
    .array(
      z.union([
        text,
        z.strictObject({
          id: text.optional(),
          kind: z.enum(["tool", "item", "plan", "approval", "command-output", "patch"]),
          text,
          label: text,
          icon: text.optional(),
          detail: text.optional(),
          status: text.optional(),
          complete: z.boolean().optional(),
          toolName: text.optional(),
          prefix: z.boolean().optional(),
        }),
      ]),
    )
    .max(128),
  label: text.optional(),
  statusHeadline: text.optional(),
  statusHeadlineFormat: z.literal("plain").optional(),
  plan: z
    .array(
      z.strictObject({
        step: text,
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .max(64)
    .optional(),
  planExplanation: text.optional(),
  planExplanationFormat: z.literal("plain").optional(),
  preparedBlocks: z
    .array(z.strictObject({ text, format: z.enum(["plain", "markdown"]) }))
    .max(64)
    .optional(),
  diffStat: z.strictObject({ files: counter, added: counter, removed: counter }).optional(),
}) satisfies z.ZodType<ChannelProgressDraftCompositorSnapshot>;

export function serializeConversationProgressSnapshot(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): string {
  const parsed = snapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error("Invalid conversation progress snapshot");
  }
  const serialized = JSON.stringify(parsed.data);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new Error("Conversation progress snapshot exceeds 64 KiB");
  }
  return serialized;
}

export function parseConversationProgressSnapshot(
  value: string | null | undefined,
): ChannelProgressDraftCompositorSnapshot | undefined {
  if (
    !value ||
    value.length > MAX_SNAPSHOT_BYTES ||
    Buffer.byteLength(value, "utf8") > MAX_SNAPSHOT_BYTES
  ) {
    return undefined;
  }
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(value) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Optional presentation state cannot hide authoritative delivery evidence.
    return undefined;
  }
}
