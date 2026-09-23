import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { stripThinkingTags } from "../strip-thinking-tags.ts";
import type { NormalizedMessage } from "./chat-types.ts";

/** Keep internal oversized-history markers out of every user-visible text surface. */
export function resolveMessageDisplayMarkdown(
  message: unknown,
  normalizedMessage: NormalizedMessage,
): string {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  if (metadata?.truncated === true && metadata.reason === "oversized") {
    return t("chat.messages.tooLargeToDisplay");
  }
  const markdown = normalizedMessage.content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? item.text : []))
    .join("\n");
  return normalizedMessage.role.toLowerCase() === "assistant"
    ? stripThinkingTags(markdown)
    : markdown;
}
