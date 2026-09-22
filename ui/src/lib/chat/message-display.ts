import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE } from "../../../../src/shared/session-run-error.ts";
import { t } from "../../i18n/index.ts";
import { redactToolDetail } from "../browser-redact.ts";
import { stripThinkingTags } from "../strip-thinking-tags.ts";
import type { NormalizedMessage } from "./chat-types.ts";

/** Keep internal oversized-history markers out of every user-visible text surface. */
export function resolveMessageDisplayMarkdown(
  message: unknown,
  normalizedMessage: NormalizedMessage,
): string {
  const record = asNullableRecord(message);
  const metadata = asNullableRecord(record?.["__openclaw"]);
  if (metadata?.truncated === true && metadata.reason === "oversized") {
    return t("chat.messages.tooLargeToDisplay");
  }
  const markdown = normalizedMessage.content
    .flatMap((item) => (item.type === "text" && typeof item.text === "string" ? item.text : []))
    .join("\n");
  // Diagnostic cards and message actions must share the same redacted text.
  if (record?.role === "custom" && record.customType === RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE) {
    return redactToolDetail(markdown, { preservePaths: true });
  }
  return normalizedMessage.role.toLowerCase() === "assistant"
    ? stripThinkingTags(markdown)
    : markdown;
}
