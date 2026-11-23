import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord as asToolRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
  resolveToolUseId,
} from "../../../../src/chat/tool-content.js";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping } from "../../lib/chat/message-normalizer.ts";
import { readPreparedActivity } from "../../lib/chat/prepared-activity.ts";
import { lastUserMessageIndex } from "./stream-causal-boundary.ts";
import type { LiveToolStreamState } from "./tool-stream-contract.ts";

type ToolMessageRef = {
  id: string;
  runId?: string;
};

type LiveToolStreamRef = ToolMessageRef & {
  identity: string;
};

const TOOL_NAME_FIELDS = ["toolName", "tool_name"] as const;

/** Tool call ids belong to one run; sibling runs may legitimately reuse them. */
export function buildToolStreamIdentity(runId: string, toolCallId: string): string {
  return JSON.stringify([runId, toolCallId]);
}

export function toolStreamIdentityRunId(identity: string): string | undefined {
  const parts = safeParseJson(identity);
  return Array.isArray(parts) &&
    parts.length === 2 &&
    typeof parts[0] === "string" &&
    typeof parts[1] === "string"
    ? parts[0]
    : undefined;
}

function isToolMessageContentBlock(block: Record<string, unknown>): boolean {
  return isToolCallContentType(block.type) || isToolResultContentType(block.type);
}

/** Reads invocation ids without confusing row ids or inventing a missing run owner. */
export function extractToolMessageRefs(
  message: unknown,
  settledCalls?: ReadonlySet<string>,
): ToolMessageRef[] {
  const record = asToolRecord(message);
  if (!record) {
    return [];
  }

  const refs = new Map<string, ToolMessageRef>();
  const add = (id: string | undefined, runId: string | undefined, result: boolean) => {
    if (id && (result || !settledCalls || settledCalls.has(id))) {
      refs.set(buildToolStreamIdentity(runId ?? "", id), { id, runId });
    }
  };
  const blocks = Array.isArray(record.content)
    ? record.content.filter(
        (block): block is Record<string, unknown> => Boolean(block) && typeof block === "object",
      )
    : [];
  const topLevelToolId = resolveToolUseId({ ...record, id: undefined });
  const topLevelRunId =
    readSessionMessageIdentity(record)?.runId ?? normalizeOptionalString(record.runId);
  const role = record.role;
  const isResult = typeof role === "string" && normalizeRoleForGrouping(role) === "tool";
  if (
    topLevelToolId &&
    (isResult ||
      TOOL_NAME_FIELDS.some((field) => normalizeOptionalString(record[field])) ||
      blocks.some(isToolMessageContentBlock))
  ) {
    add(topLevelToolId, topLevelRunId, isResult);
  }
  for (const block of blocks) {
    const result = isToolResultContentType(block.type);
    if (result || isToolCallContentType(block.type)) {
      add(
        resolveToolUseId(block) ?? topLevelToolId,
        normalizeOptionalString(block.runId) ?? topLevelRunId,
        result,
      );
    }
  }

  return [...refs.values()];
}

export function resolveLiveToolStreamRefs(state: LiveToolStreamState): LiveToolStreamRef[] {
  return state.toolStreamOrder.map((identity) => {
    const entry = state.toolStreamById.get(identity);
    const id = normalizeOptionalString(entry?.toolCallId) ?? identity;
    const runId = normalizeOptionalString(entry?.runId);
    return { identity, id, runId };
  });
}

/** Persisted prefixes and keyed commentary do not consume an indexed live call. */
export function createSegmentToolRefReader(refs: LiveToolStreamRef[]) {
  let index = 0;
  return (segment: ChatStreamSegment) => {
    const itemId = normalizeOptionalString(segment.itemId);
    return {
      itemId,
      runId: normalizeOptionalString(segment.runId),
      callId: normalizeOptionalString(segment.toolCallId),
      indexed: !itemId && segment.persisted !== true ? refs[index++] : undefined,
    };
  };
}

/** Unscoped history cannot prove which sibling owns a reused tool call id. */
export function resolveMatchingLiveToolIdentity(
  ref: ToolMessageRef,
  liveToolRefs: LiveToolStreamRef[],
): string | undefined {
  const matches = liveToolRefs.filter(
    (liveRef) =>
      liveRef.id === ref.id && (!ref.runId || !liveRef.runId || liveRef.runId === ref.runId),
  );
  return matches.length === 1 ? matches[0]?.identity : undefined;
}

export function persistedCurrentToolStreamIds(
  messages: unknown[],
  state: LiveToolStreamState,
): Set<string> {
  const liveToolRefs = resolveLiveToolStreamRefs(state);
  const matchedToolIds = new Set<string>();
  if (liveToolRefs.length === 0) {
    return matchedToolIds;
  }
  for (let index = lastUserMessageIndex(messages) + 1; index < messages.length; index++) {
    const message = messages[index];
    // A saved call only proves invocation identity. Retire its live execution
    // facts when history has an outcome, including prepared receipts whose
    // result lies outside the rendered page.
    const settledCalls = new Set(
      readPreparedActivity(message)
        .filter((item) => item.phase === "end" && !item.unpairedCall)
        .map((item) => item.toolCallId ?? item.itemId),
    );
    for (const ref of extractToolMessageRefs(message, settledCalls)) {
      const identity = resolveMatchingLiveToolIdentity(ref, liveToolRefs);
      if (identity) {
        matchedToolIds.add(identity);
      }
    }
  }
  return matchedToolIds;
}
