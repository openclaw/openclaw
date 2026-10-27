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
import { warnMentionInboxDeprecation } from "../plugins/compat/mention-inbox-deprecation.js";
import type { MentionCommittedInput, MentionInboxOptions } from "./mention-inbox.types.js";
import { deriveSessionTitle } from "./session-utils-core.js";

export function deprecatedMentionInboxError(
  method: "list" | "dismiss" | "recordCommittedInput" | "invalidate",
): ErrorShape {
  warnMentionInboxDeprecation(method);
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    `mentionInbox.${method} is unavailable; await mentionInbox.${method}Async instead.`,
  );
}

export function publishMentionDeliveryFailure(
  params: Pick<MentionInboxOptions, "gatewayInstanceId" | "broadcastToConnIds">,
  input: MentionCommittedInput,
  connections: Set<string>,
  cause: unknown,
): Error {
  const failure = new Error(
    "Your message was posted, but mention notifications could not be delivered. Reload the Inbox before retrying.",
    { cause },
  );
  if (connections.size) {
    params.broadcastToConnIds(
      "mentions.failed",
      {
        gatewayInstanceId: params.gatewayInstanceId,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        messageId: input.messageId,
        errorMessage: failure.message,
      },
      connections,
    );
  }
  return failure;
}

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
