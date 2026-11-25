import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { CHAT_MESSAGE_MAX_CHARS } from "../../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatMessageGetResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import {
  type AssistantPhase,
  isAssistantTextContentBlockType,
  parseAssistantTextSignature,
} from "../../../../src/shared/chat-message-content.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionOrganizationSharedEnglish } from "../../i18n/locales/en-session-organization-shared.ts";
import type { ChatHistoryResult } from "../../pages/chat/chat-history-snapshot.ts";
import {
  nativeHistoryMessageIdentity,
  nativeHistoryMessageSourceId,
} from "./history-message-identity.ts";

registerSessionOrganizationSharedEnglish();

function isTruncatedHistoryMessage(message: unknown): boolean {
  return asNullableRecord(asNullableRecord(message)?.["__openclaw"])?.truncated === true;
}

function hasMixedAssistantTextPhases(message: Record<string, unknown>): boolean {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return false;
  }
  const phases = new Set<AssistantPhase | undefined>();
  for (const item of message.content) {
    const block = asNullableRecord(item);
    if (
      block &&
      isAssistantTextContentBlockType(block.type) &&
      typeof block.text === "string" &&
      block.text.trim()
    ) {
      phases.add(parseAssistantTextSignature(block)?.phase);
    }
  }
  return phases.size > 1;
}

/** Read one coherent conversation, recovering capped rows the caller needs in full. */
export async function loadCompleteChatHistory(
  {
    client,
    sessionKey,
    sessionId,
    agentId,
    isCurrent,
  }: {
    client: GatewayBrowserClient;
    sessionKey: string;
    sessionId?: string | null;
    agentId?: string;
    isCurrent: () => boolean;
  },
  needsFullMessage: (message: unknown) => boolean,
): Promise<unknown[]> {
  const pages: unknown[][] = [];
  const recovered = new Map<string, Record<string, unknown>>();
  const seenCounts = new Map<string, number>();
  const requestHistory = (offset: number, limit = 1000) =>
    client.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      agentId,
      limit,
      maxChars: 500_000,
      offset,
    });
  const recoverMessage = async (row: unknown, page: ChatHistoryResult) => {
    const messageId = nativeHistoryMessageSourceId(row);
    // The Gateway fetches a whole source row. It cannot address one of its display siblings.
    if (
      !messageId ||
      !page.sessionId ||
      page.messages?.some(
        (other) => other !== row && nativeHistoryMessageSourceId(other) === messageId,
      )
    ) {
      throw new Error(t("chat.historyUnavailableTitle"));
    }
    const cached = recovered.get(messageId);
    if (cached) {
      return cached;
    }
    const result = await client.request<ChatMessageGetResult>("chat.message.get", {
      sessionKey,
      sessionId: page.sessionId,
      agentId,
      messageId,
      maxChars: CHAT_MESSAGE_MAX_CHARS,
    });
    if (!isCurrent()) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
    const full = asNullableRecord(result.message);
    // A single reference can also stand for a whole group. Rendering a folded
    // commentary/final result as one row would silently discard the commentary.
    if (
      !result.ok ||
      !full ||
      isTruncatedHistoryMessage(full) ||
      hasMixedAssistantTextPhases(full)
    ) {
      throw new Error(t("chat.historyUnavailableTitle"));
    }
    recovered.set(messageId, full);
    return full;
  };
  let offset = 0;
  let snapshot: ChatHistoryResult | undefined;
  while (true) {
    const page = await requestHistory(offset);
    // Offsets are relative to the current tail. Never stitch different sessions,
    // branches, or growing transcripts into a seemingly complete export.
    if (
      !isCurrent() ||
      (sessionId && page.sessionId !== sessionId) ||
      (snapshot &&
        (page.sessionId !== snapshot.sessionId || page.totalMessages !== snapshot.totalMessages))
    ) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
    snapshot ??= page;
    const pageCounts = new Map<string, number>();
    const messages: unknown[] = [];
    for (const row of page.messages ?? []) {
      const message =
        isTruncatedHistoryMessage(row) && needsFullMessage(row)
          ? await recoverMessage(row, page)
          : row;
      const identity = nativeHistoryMessageIdentity(message);
      if (identity) {
        const count = (pageCounts.get(identity) ?? 0) + 1;
        pageCounts.set(identity, count);
        if (count <= (seenCounts.get(identity) ?? 0)) {
          continue;
        }
      }
      messages.push(message);
    }
    for (const [identity, count] of pageCounts) {
      seenCounts.set(identity, Math.max(count, seenCounts.get(identity) ?? 0));
    }
    pages.push(messages);
    if (!page.hasMore) {
      break;
    }
    if (page.nextOffset === undefined || page.nextOffset <= offset) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
    offset = page.nextOffset;
  }
  if (pages.length > 1 || recovered.size > 0) {
    // Offsets and by-ID reads can cross a branch switch or rewrite. Only the
    // tail page carries the branch marker and history cursor to recheck.
    const tail = await requestHistory(0, 1);
    if (
      !isCurrent() ||
      tail.sessionId !== snapshot.sessionId ||
      tail.totalMessages !== snapshot.totalMessages ||
      tail.deltaCursor !== snapshot.deltaCursor ||
      tail.sessionInfo?.activeLeafEntryId !== snapshot.sessionInfo?.activeLeafEntryId
    ) {
      throw new Error(t("sessionsView.copyTranscriptChanged"));
    }
  }
  return pages.toReversed().flat();
}
