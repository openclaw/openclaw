import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { err, type Result } from "@openclaw/normalization-core/result";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
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

export function mentionInboxUnavailable(
  log?: Pick<SubsystemLogger, "warn">,
): Result<never, ErrorShape> {
  log?.warn("The mention Inbox could not read or save its current state. Reconnect to retry.");
  return err(
    errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry.", {
      retryable: true,
    }),
  );
}
