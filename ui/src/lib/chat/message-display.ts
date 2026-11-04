import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { stripThinkingTags } from "../strip-thinking-tags.ts";
import type { NormalizedMessage } from "./chat-types.ts";
import { readHumanMentions } from "./human-mentions.ts";
import { normalizeMessage } from "./message-normalizer.ts";

const displayMarkdownCache = new WeakMap<NormalizedMessage, string>();

/** Keep internal oversized-history markers out of every user-visible text surface. */
export function resolveMessageDisplayMarkdown(
  message: unknown,
  normalizedMessage: NormalizedMessage,
): string {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  if (metadata?.truncated === true && metadata.reason === "oversized") {
    return t("chat.messages.tooLargeToDisplay");
  }
  const cached = displayMarkdownCache.get(normalizedMessage);
  if (cached !== undefined) {
    return cached;
  }
  const markdown = normalizedMessage.content
    .flatMap((item) => (item.type === "text" ? (item.text ?? []) : []))
    .join("\n");
  const result =
    normalizedMessage.role.toLowerCase() === "assistant" ? stripThinkingTags(markdown) : markdown;
  displayMarkdownCache.set(normalizedMessage, result);
  return result;
}

// Options and action handlers outlive a render; keep this preparation separate from them.
export function prepareChatMessageRender(message: unknown) {
  const normalizedMessage = normalizeMessage(message);
  const displayMarkdown = resolveMessageDisplayMarkdown(message, normalizedMessage);
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  let humanMentions: ReturnType<typeof readHumanMentions>;
  // Gateway-authored assistant rows may carry the same selections as human input.
  if ((record?.role === "user" || record?.role === "assistant") && metadata?.humanMentions) {
    const source =
      typeof record.content === "string"
        ? record.content
        : Array.isArray(record.content)
          ? record.content
              .flatMap((block: unknown) => {
                const item = asNullableRecord(block);
                return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
              })
              .join("\n")
          : null;
    // Selections belong to submitted bytes, not a stripped envelope or display cap.
    if (source === displayMarkdown) {
      humanMentions = readHumanMentions(displayMarkdown, metadata.humanMentions);
    }
  }
  return { message, normalizedMessage, displayMarkdown, humanMentions };
}

export type ChatMessageRenderPreparation = ReturnType<typeof prepareChatMessageRender>;
