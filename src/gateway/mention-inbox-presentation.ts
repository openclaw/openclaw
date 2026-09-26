import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionEntry } from "../config/sessions.js";
import { deriveSessionTitle } from "./session-utils-core.js";

export function formatMentionSessionTitle(entry: SessionEntry | undefined): string {
  return (
    truncateUtf16Safe(
      (deriveSessionTitle(entry) ?? "Conversation")
        .replace(/[\p{Cc}\p{Cf}]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim(),
      256,
    ) || "Conversation"
  );
}

export function formatMentionExcerpt(excerpt: string | undefined): string | undefined {
  return excerpt
    ? truncateUtf16Safe(
        flattenMarkdownToPlainText(truncateUtf16Safe(excerpt, 2_048))
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        280,
      )
    : undefined;
}
