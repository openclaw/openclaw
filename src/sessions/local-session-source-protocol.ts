// Wire contract between a paired device's local session source (Codex daemon,
// Claude Code transcripts) and the Gateway bridge that projects those sessions
// for the team. Frames travel as UTF-8 JSON over one plugin-owned node duplex.
import { z } from "zod";

export const LOCAL_SESSION_SOURCE_PROTOCOL_VERSION = 1;
/** Per-record text ceiling; sources clip and flag instead of dropping the record. */
export const LOCAL_SESSION_RECORD_TEXT_MAX_BYTES = 64 * 1024;
/** Bootstrap bounds reuse the Codex history projection limits. */
export const LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS = 200;
export const LOCAL_SESSION_BOOTSTRAP_MAX_BYTES = 512 * 1024;

const nonEmpty = z.string().trim().min(1);
const timestampMs = z.number().int().nonnegative();

const localSessionInputModeSchema = z.enum(["steer", "followup"]);
export type LocalSessionInputMode = z.infer<typeof localSessionInputModeSchema>;

const localSessionRecordKindSchema = z.enum([
  "user",
  "assistant",
  "reasoning",
  "toolCall",
  "toolResult",
]);

const localSessionRecordSchema = z
  .object({
    /** Stable native identity; doubles as the transcript idempotency key. */
    id: nonEmpty,
    /** Monotone per thread, owned by the source so resume cursors survive restarts. */
    seq: z.number().int().positive(),
    ts: timestampMs,
    kind: localSessionRecordKindSchema,
    text: z.string().max(LOCAL_SESSION_RECORD_TEXT_MAX_BYTES),
    turnId: nonEmpty.optional(),
    /** Correlates a native user item back to the Gateway input that produced it. */
    clientId: nonEmpty.optional(),
    toolName: nonEmpty.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type LocalSessionRecord = z.infer<typeof localSessionRecordSchema>;

const localSessionThreadStateSchema = z.enum(["idle", "active", "closed", "unavailable"]);
export type LocalSessionThreadState = z.infer<typeof localSessionThreadStateSchema>;

const sourceHelloFrameSchema = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal(LOCAL_SESSION_SOURCE_PROTOCOL_VERSION),
    sourceId: nonEmpty,
    hostLabel: nonEmpty.optional(),
    inputModes: z.array(localSessionInputModeSchema),
  })
  .strict();

const sourceConsentFrameSchema = z
  .object({
    type: z.literal("consent"),
    enrollmentId: nonEmpty,
    decision: z.enum(["accepted", "declined"]),
  })
  .strict();

const sourceSessionFrameSchema = z
  .object({
    type: z.literal("session"),
    threadId: nonEmpty,
    state: localSessionThreadStateSchema,
    canInput: z.boolean(),
    title: z.string().max(512).optional(),
    cwd: z.string().max(4096).optional(),
    reason: z.string().max(512).optional(),
    startedAt: timestampMs.optional(),
    updatedAt: timestampMs.optional(),
    /** Earliest record seq the source can still replay; absent means full history. */
    earliestSeq: z.number().int().positive().optional(),
  })
  .strict();

const sourceRecordsFrameSchema = z
  .object({
    type: z.literal("records"),
    threadId: nonEmpty,
    records: z.array(localSessionRecordSchema).min(1).max(LOCAL_SESSION_BOOTSTRAP_MAX_RECORDS),
  })
  .strict();

const sourceDeltaFrameSchema = z
  .object({
    type: z.literal("delta"),
    threadId: nonEmpty,
    turnId: nonEmpty,
    itemId: nonEmpty,
    text: z.string().max(LOCAL_SESSION_RECORD_TEXT_MAX_BYTES),
  })
  .strict();

const sourceTurnFrameSchema = z
  .object({
    type: z.literal("turn"),
    threadId: nonEmpty,
    turnId: nonEmpty,
    state: z.enum(["started", "completed", "failed", "interrupted"]),
  })
  .strict();

const localSessionInputOutcomeSchema = z.enum(["committed", "submitted", "rejected"]);

const sourceInputResultFrameSchema = z
  .object({
    type: z.literal("inputResult"),
    inputId: nonEmpty,
    threadId: nonEmpty,
    outcome: localSessionInputOutcomeSchema,
    nativeRef: nonEmpty.optional(),
    reason: z.string().max(512).optional(),
  })
  .strict();

const localSessionSourceFrameSchema = z.discriminatedUnion("type", [
  sourceHelloFrameSchema,
  sourceConsentFrameSchema,
  sourceSessionFrameSchema,
  sourceRecordsFrameSchema,
  sourceDeltaFrameSchema,
  sourceTurnFrameSchema,
  sourceInputResultFrameSchema,
]);
export type LocalSessionSourceFrame = z.infer<typeof localSessionSourceFrameSchema>;
export type LocalSessionSourceSessionFrame = z.infer<typeof sourceSessionFrameSchema>;
export type LocalSessionSourceInputResultFrame = z.infer<typeof sourceInputResultFrameSchema>;

const enrollmentSummarySchema = z
  .object({
    enrollmentId: nonEmpty,
    agentId: nonEmpty,
    requester: z.object({ profileId: nonEmpty, displayName: nonEmpty }).strict(),
    audienceLabel: nonEmpty,
    /** Set when a profile-minted connect link created the enrollment; pre-consents bind to it. */
    setupId: nonEmpty.optional(),
  })
  .strict();
export type LocalSessionEnrollmentSummary = z.infer<typeof enrollmentSummarySchema>;

const gatewayOfferFrameSchema = z
  .object({ type: z.literal("offer"), enrollment: enrollmentSummarySchema })
  .strict();

const gatewayResumeFrameSchema = z
  .object({
    type: z.literal("resume"),
    enrollment: enrollmentSummarySchema,
    /** Last committed seq per thread; the source replays everything after it. */
    cursors: z.record(nonEmpty, z.number().int().nonnegative()),
    excludedThreadIds: z.array(nonEmpty),
  })
  .strict();

const gatewayAckFrameSchema = z
  .object({ type: z.literal("ack"), threadId: nonEmpty, seq: z.number().int().positive() })
  .strict();

const gatewayInputFrameSchema = z
  .object({
    type: z.literal("input"),
    inputId: nonEmpty,
    threadId: nonEmpty,
    mode: localSessionInputModeSchema,
    text: z.string().min(1).max(LOCAL_SESSION_RECORD_TEXT_MAX_BYTES),
    sender: z.object({ profileId: nonEmpty.optional(), displayName: nonEmpty }).strict(),
  })
  .strict();
export type LocalSessionGatewayInputFrame = z.infer<typeof gatewayInputFrameSchema>;

const gatewayUnshareFrameSchema = z
  .object({ type: z.literal("unshare"), threadId: nonEmpty })
  .strict();

const gatewayRevokeFrameSchema = z.object({ type: z.literal("revoke") }).strict();

const localSessionGatewayFrameSchema = z.discriminatedUnion("type", [
  gatewayOfferFrameSchema,
  gatewayResumeFrameSchema,
  gatewayAckFrameSchema,
  gatewayInputFrameSchema,
  gatewayUnshareFrameSchema,
  gatewayRevokeFrameSchema,
]);
export type LocalSessionGatewayFrame = z.infer<typeof localSessionGatewayFrameSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function encodeLocalSessionFrame(
  frame: LocalSessionSourceFrame | LocalSessionGatewayFrame,
): Uint8Array {
  return encoder.encode(JSON.stringify(frame));
}

export function decodeLocalSessionSourceFrame(message: Uint8Array): LocalSessionSourceFrame {
  return localSessionSourceFrameSchema.parse(JSON.parse(decoder.decode(message)));
}

export function decodeLocalSessionGatewayFrame(message: Uint8Array): LocalSessionGatewayFrame {
  return localSessionGatewayFrameSchema.parse(JSON.parse(decoder.decode(message)));
}

/** Clip record text to the wire ceiling; sources call this before publishing. */
export function clipLocalSessionRecordText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= LOCAL_SESSION_RECORD_TEXT_MAX_BYTES) {
    return { text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf8").subarray(0, LOCAL_SESSION_RECORD_TEXT_MAX_BYTES - 16);
  return { text: `${clipped.toString("utf8")}\n…[truncated]`, truncated: true };
}

/** Sender envelope injected into the native model so the local harness knows who spoke. */
export function formatLocalSessionInputEnvelope(input: {
  senderDisplayName: string;
  inputId: string;
  text: string;
}): string {
  return `[${input.senderDisplayName} via OpenClaw team · message ${input.inputId.slice(0, 8)}]\n${input.text}`;
}
