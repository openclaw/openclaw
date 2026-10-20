import type { SessionTreeEntry } from "@openclaw/agent-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";

export const TRANSCRIPT_NAVIGATION_KEYS = [
  "type",
  "id",
  "parentId",
  "targetId",
  "appendParentId",
  "appendMode",
] as const;

export const MODEL_CONTEXT_NAVIGATION_KEYS = [
  ...TRANSCRIPT_NAVIGATION_KEYS,
  "timestamp",
  "version",
  "cwd",
  "firstKeptEntryId",
  "reason",
  "tokensBefore",
  "thinkingLevel",
  "provider",
  "modelId",
  "fromId",
  "customType",
  "display",
  "excludeFromContext",
  "label",
  "name",
] as const;

export const MODEL_MESSAGE_NAVIGATION_KEYS = [
  "role",
  "provider",
  "model",
  "timestamp",
  "excludeFromContext",
  "toolCallId",
  "toolUseId",
  "tool_call_id",
  "tool_use_id",
  "callId",
  "call_id",
  "toolName",
  "isError",
  "stopReason",
  "customType",
  "display",
] as const;

function pickNavigation(record: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]),
  );
}
export function projectSessionModelContextNavigation(entry: SessionTreeEntry): SessionTreeEntry {
  const projected: Pick<SessionTreeEntry, "type" | "id" | "parentId" | "timestamp"> &
    Record<string, unknown> = {
    ...pickNavigation({ ...entry }, MODEL_CONTEXT_NAVIGATION_KEYS),
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
  };
  if (entry.type === "message") {
    const message = entry.message;
    const original: Record<string, unknown> = { ...message };
    const calls =
      "content" in message && Array.isArray(message.content)
        ? message.content.flatMap((item) =>
            isRecord(item) && ["toolCall", "toolUse", "functionCall"].includes(item.type)
              ? [pickNavigation(item, ["type", "id", "name"])]
              : [],
          )
        : [];
    const details = isRecord(original.details) ? original.details : {};
    const operatorKind =
      original.customType === "openclaw.system-update" &&
      (details.kind === "prompt-update" || details.kind === "runtime-context")
        ? details.kind
        : undefined;
    projected.message = {
      ...pickNavigation(original, MODEL_MESSAGE_NAVIGATION_KEYS),
      content: calls,
      command: "",
      output: "",
      providerReplay: {
        type: isRecord(original.providerReplay) ? original.providerReplay.type : null,
      },
      details: {
        [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: isSyntheticMissingToolResult({
          isError: original.isError,
          details: original.details,
          content: original.content,
        }),
        ...(operatorKind ? { kind: operatorKind } : {}),
      },
    };
  } else if (entry.type === "compaction" || entry.type === "branch_summary") {
    projected.summary = "";
  } else if (entry.type === "custom_message") {
    projected.content = [];
    if (
      entry.customType === "openclaw.system-update" &&
      isRecord(entry.details) &&
      (entry.details.kind === "prompt-update" || entry.details.kind === "runtime-context")
    ) {
      projected.details = { kind: entry.details.kind };
    }
  } else if (entry.type === "custom" && entry.customType === "openclaw.system-prompt") {
    projected.data = { restart: isRecord(entry.data) && entry.data.restart === true };
  }
  // SAFETY: Navigation preserves every entry discriminant and control field with empty payloads.
  return projected as SessionTreeEntry;
}
