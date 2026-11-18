import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  classifySessionFileEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-entry-codec.js";
import { MIN_READABLE_SESSION_VERSION } from "./version.js";

const canonicalEntryShape = {
  id: z.string().min(1),
  parentId: z.union([z.string(), z.null()]).optional(),
  timestamp: z.string().optional(),
  // The entry codec accepts arbitrary appendMode values; only "side" changes navigation.
  appendMode: z.unknown().optional(),
};
const canonicalFactsSchema = z
  .object({
    kind: z.literal("canonical"),
    hasParentId: z.boolean(),
    entry: z.discriminatedUnion("type", [
      z.object({
        ...canonicalEntryShape,
        type: z.literal("message"),
        assistantResponseId: z.string().optional(),
        assistantRunId: z.string().optional(),
      }),
      z.object({
        ...canonicalEntryShape,
        type: z.literal("custom_message"),
        customType: z.string().min(1),
      }),
      z.object({
        ...canonicalEntryShape,
        type: z.literal("label"),
        targetId: z.string().min(1),
        label: z.string().optional(),
      }),
      z.object({
        ...canonicalEntryShape,
        type: z.enum([
          "thinking_level_change",
          "model_change",
          "compaction",
          "reset",
          "branch_summary",
          "custom",
          "session_info",
        ]),
      }),
    ]),
  })
  .refine(({ entry, hasParentId }) => hasParentId === (entry.parentId !== undefined));

export type SessionTranscriptReportFacts =
  | z.infer<typeof canonicalFactsSchema>
  | { kind: "leaf"; entry: NonNullable<ReturnType<typeof parseOpaqueLeafEntry>> }
  | { kind: "link"; id: string; parentId: string | null }
  | { kind: "ignored" };

/** Classify the original parsed row; callers retain the current-header guard. */
export function projectSessionTranscriptReportFacts(raw: unknown): SessionTranscriptReportFacts {
  const { entry, recognized } = classifySessionFileEntry(raw, MIN_READABLE_SESSION_VERSION);
  if (!recognized || entry.type === "session") {
    const leaf = parseOpaqueLeafEntry(raw);
    if (leaf) {
      return { kind: "leaf", entry: leaf };
    }
    const link = parseParentLinkedOpaqueEntry(raw);
    return link ? { kind: "link", ...link } : { kind: "ignored" };
  }
  const common = {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    appendMode: entry.appendMode,
  };
  const hasParentId = Object.hasOwn(entry, "parentId");
  if (entry.type === "label") {
    return {
      kind: "canonical",
      hasParentId,
      entry: { ...common, type: entry.type, targetId: entry.targetId, label: entry.label },
    };
  }
  if (entry.type === "custom_message") {
    return {
      kind: "canonical",
      hasParentId,
      entry: { ...common, type: entry.type, customType: entry.customType },
    };
  }
  if (entry.type === "message") {
    return {
      kind: "canonical",
      hasParentId,
      entry: {
        ...common,
        type: entry.type,
        ...(entry.message.role === "assistant"
          ? {
              assistantRunId: readSessionTranscriptRunId(entry.message),
              ...(typeof entry.message.responseId === "string"
                ? { assistantResponseId: entry.message.responseId }
                : {}),
            }
          : {}),
      },
    };
  }
  return { kind: "canonical", hasParentId, entry: { ...common, type: entry.type } };
}

/** Validate stored facts without reclassifying a synthetic message body. */
export function decodeSessionTranscriptReportFacts(
  value: unknown,
): SessionTranscriptReportFacts | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value.kind) {
    case "canonical": {
      const parsed = canonicalFactsSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }
    case "leaf": {
      if (!isRecord(value.entry)) {
        return undefined;
      }
      const entry = parseOpaqueLeafEntry({ ...value.entry, type: "leaf" });
      return entry ? { kind: "leaf", entry } : undefined;
    }
    case "link": {
      const entry = parseParentLinkedOpaqueEntry(value);
      return entry ? { kind: "link", ...entry } : undefined;
    }
    case "ignored":
      return { kind: "ignored" };
    default:
      return undefined;
  }
}
