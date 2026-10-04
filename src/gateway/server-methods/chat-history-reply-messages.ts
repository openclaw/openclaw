import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { CHAT_PENDING_INPUT_MESSAGE_PREFIX } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import type { ChatMessageGetResult } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatHistoryPageParams } from "../../config/sessions/session-history-types.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import {
  projectChatDisplayMessage,
  type ChatDisplayProjectionOptions,
} from "../chat-display-projection.core.js";
import type { SessionTranscriptPageReader } from "../session-transcript-read.types.js";

/** Batch label projection includes quoted originals without recursively following their replies. */
export async function projectChatHistoryWithReplies(
  messages: Record<string, unknown>[],
  project: (
    messages: Record<string, unknown>[],
  ) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> {
  const originals: Record<string, unknown>[] = [];
  const references = messages.map((message) => {
    const reply = asOptionalRecord(asOptionalRecord(message["__openclaw"])?.replyToMessage);
    const original = asOptionalRecord(reply?.message);
    return original ? { reply, index: originals.push(original) - 1 } : undefined;
  });
  const projected = await project([...messages, ...originals]);
  const result = projected.slice(0, messages.length);
  for (const [index, message] of result.entries()) {
    const reference = references[index];
    if (!reference) {
      continue;
    }
    const original = projected[messages.length + reference.index];
    result[index] = {
      ...message,
      __openclaw: {
        ...asOptionalRecord(message["__openclaw"]),
        replyToMessage:
          jsonUtf8Bytes(original) > 8 * 1024
            ? { ok: false, unavailableReason: "oversized" }
            : { ...reference.reply, message: original },
      },
    };
  }
  return result;
}

export function readChatHistoryReplyMessageId(message: unknown): string | undefined {
  const record = asOptionalRecord(message);
  return (
    normalizeOptionalString(asOptionalRecord(record?.["__openclaw"])?.replyToId) ??
    (record?.role === "assistant"
      ? normalizeOptionalString(asOptionalRecord(record.openclawDelivery)?.replyToId)
      : undefined)
  );
}

/** Page-local reads share the admitted transcript owner and never start client RPCs. */
export async function attachChatHistoryReplyMessages(
  messages: unknown[],
  params: ChatHistoryPageParams,
  options: Pick<
    ChatDisplayProjectionOptions,
    "resolveCronJobName" | "resolveCurrentUserProfileDisplay"
  > & {
    readers: Pick<
      SessionTranscriptPageReader,
      "readSessionMessageByIdAsync" | "subagentCoordination"
    >;
    deferProfileDisplay?: boolean;
  },
): Promise<unknown[]> {
  const replies = new Map<string, ChatMessageGetResult>();
  const result: unknown[] = [];
  for (const message of messages) {
    const record = asOptionalRecord(message);
    const metadata = asOptionalRecord(record?.["__openclaw"]);
    const messageId = readChatHistoryReplyMessageId(message);
    if (!record || !messageId || !params.sessionId) {
      result.push(message);
      continue;
    }
    let reply = replies.get(messageId);
    if (!reply && messageId.startsWith(CHAT_PENDING_INPUT_MESSAGE_PREFIX)) {
      // Pending custody is joined separately; its namespace cannot select transcript rows.
      reply = { ok: false, unavailableReason: "not_found" };
    }
    if (!reply) {
      const original = await options.readers.readSessionMessageByIdAsync(
        {
          agentId: params.sessionAgentId,
          sessionId: params.sessionId,
          sessionKey: params.canonicalKey,
          storePath: params.storePath,
          sessionEntry: params.entry,
        },
        messageId,
        {
          allowResetArchiveFallback: true,
          historyVisibility: { sessionStartedAt: params.entry?.sessionStartedAt },
        },
      );
      const projected = original.message
        ? projectChatDisplayMessage(original.message, {
            maxChars: 500,
            subagentCoordination: options.readers.subagentCoordination,
            resolveCronJobName: options.resolveCronJobName,
            ...(options.deferProfileDisplay
              ? {}
              : { resolveCurrentUserProfileDisplay: options.resolveCurrentUserProfileDisplay }),
          })
        : undefined;
      // Quoted previews do not display model identity; keep role-specific model policy
      // at the response owner without introducing a nested disclosure site.
      const preview = projected ? { ...projected } : undefined;
      if (preview) {
        delete preview.provider;
        delete preview.model;
      }
      reply =
        original.oversized || (preview && jsonUtf8Bytes(preview) > 8 * 1024)
          ? { ok: false, unavailableReason: "oversized" }
          : preview
            ? { ok: true, message: preview }
            : { ok: false, unavailableReason: original.found ? "not_visible" : "not_found" };
      replies.set(messageId, reply);
    }
    result.push({ ...record, __openclaw: { ...metadata, replyToMessage: reply } });
  }
  return result;
}
