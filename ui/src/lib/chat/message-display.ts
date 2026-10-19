import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import { stripThinkingTags } from "../strip-thinking-tags.ts";
import type { NormalizedMessage } from "./chat-types.ts";

const displayMarkdown = new WeakMap<NormalizedMessage, string>();

/** Keep internal oversized-history markers out of every user-visible text surface. */
export function resolveMessageDisplayMarkdown(
  message: unknown,
  normalizedMessage: NormalizedMessage,
): string {
  const metadata = asNullableRecord(asNullableRecord(message)?.["__openclaw"]);
  if (metadata?.truncated === true && metadata.reason === "oversized") {
    return t("chat.messages.tooLargeToDisplay");
  }
  const cached = displayMarkdown.get(normalizedMessage);
  if (cached !== undefined) {
    return cached;
  }
  const markdown = normalizedMessage.content
    .flatMap((item) => (item.type === "text" ? (item.text ?? []) : []))
    .join("\n");
  const result =
    normalizedMessage.role.toLowerCase() === "assistant" ? stripThinkingTags(markdown) : markdown;
  displayMarkdown.set(normalizedMessage, result);
  return result;
}
