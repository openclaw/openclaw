import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readPluginInlineViewBlock } from "../../../../src/shared/plugin-inline-view.js";
import type { ChatItem } from "./chat-types.ts";

type MessageItem = Extract<ChatItem, { kind: "message" }>;

/** Each admitted result owns a row; never queue across turns or scan text/guest JSON. */
export function pluginInlineViewItems(item: MessageItem, seen: Set<string>): MessageItem[] {
  const entry = asOptionalRecord(item.message);
  if (!entry || entry.role === "user" || entry.isError === true) {
    return [];
  }
  const items: MessageItem[] = [];
  const add = (value: unknown, result = entry) => {
    const block = readPluginInlineViewBlock(value);
    if (!block) {
      return;
    }
    const messageIdentity = readSessionMessageIdentity(entry, {
      // A raw id equal to the call id may be a tool alias, not a durable message receipt.
      messageId:
        normalizeOptionalString(entry.messageId) ??
        (entry.id === block.toolCallId ? undefined : entry.id),
    });
    // Nested tool blocks carry their own producer facts even when their enclosing row differs.
    const resultIdentity =
      result === entry
        ? messageIdentity
        : readSessionMessageIdentity({
            role: "toolResult",
            __openclaw: result["__openclaw"],
            idempotencyKey: result.idempotencyKey,
          });
    const runId =
      resultIdentity?.runId ??
      normalizeOptionalString(result.runId) ??
      messageIdentity?.runId ??
      normalizeOptionalString(entry.runId);
    const externalSource = resultIdentity?.externalSource ?? messageIdentity?.externalSource;
    const messageId = resultIdentity?.id ?? messageIdentity?.id;
    const sequence = resultIdentity?.sequence ?? messageIdentity?.sequence;
    // Legacy rows without ownership use their receipt or the transcript owner's existing source
    // key. A bare call id cannot prove that an unscoped row belongs to another run's live result.
    const scope = runId
      ? ["run", runId]
      : externalSource
        ? ["external", externalSource]
        : messageId
          ? ["message", messageId]
          : sequence != null
            ? ["sequence", sequence]
            : ["source", item.key];
    const key = "plugin-view:" + JSON.stringify([...scope, block.toolCallId]);
    if (!seen.has(key)) {
      seen.add(key);
      items.push({
        kind: "message",
        key,
        message: {
          role: "assistant",
          id: key,
          timestamp: entry.timestamp,
          runId,
          content: [{ type: "text", text: block.summary }, block],
        },
      });
    }
  };
  add(asOptionalRecord(entry.details)?.pluginView);
  for (const value of Array.isArray(entry.content) ? entry.content : []) {
    const block = asOptionalRecord(value);
    if (
      block &&
      ["toolResult", "toolresult", "tool_result"].includes(String(block.type)) &&
      block.isError !== true
    ) {
      add(asOptionalRecord(block.details)?.pluginView, block);
    }
  }
  return items;
}
