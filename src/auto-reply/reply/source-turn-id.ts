import { createHash } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeAccountId } from "../../routing/account-id.js";

const CHANNEL_SOURCE_TURN_ID_PREFIX = "channel-user:v1:";

/**
 * Identifies one inbound channel turn across shared sessions.
 * Provider message ids are not globally unique, so route scope is mandatory.
 */
export function buildChannelSourceTurnId(params: {
  provider?: string;
  accountId?: string;
  conversationId?: string;
  messageId?: string | number;
}): string | undefined {
  const provider = normalizeOptionalLowercaseString(params.provider);
  const conversationId = normalizeOptionalString(params.conversationId);
  const messageId = normalizeOptionalString(
    typeof params.messageId === "number" ? String(params.messageId) : params.messageId,
  );
  if (!provider || !conversationId || !messageId) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify([provider, normalizeAccountId(params.accountId), conversationId, messageId]),
    )
    .digest("hex");
  return `${CHANNEL_SOURCE_TURN_ID_PREFIX}${digest}`;
}
