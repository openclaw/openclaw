import { createHash } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions/types.js";
import { normalizeAccountId } from "../../routing/account-id.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";

const CHANNEL_SOURCE_TURN_ID_PREFIX = "channel-user:v1:";
// Host and SDK bundles exchange these non-JSON context facts within one process.
const CHANNEL_SOURCE_TURN_ID = Symbol.for("openclaw.channelSourceTurnId");
const CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED = Symbol.for(
  "openclaw.channelSourceTurnSameThreadRequired",
);

type ChannelSourceTurnContext = object & {
  [CHANNEL_SOURCE_TURN_ID]?: string;
  [CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED]?: true;
};

/**
 * Internal-origin turns (gateway chat.send stamps the internal channel as the
 * ingress provider) carry run ids, not provider message ids. Minting a channel
 * source-turn id from them breaks the run-keyed user-turn admission guard;
 * gateway turns own restart via fingerprint admission and client retries.
 */
export function shouldMintChannelSourceTurnId(ingressProvider: string | undefined): boolean {
  return !isInternalMessageChannel(ingressProvider);
}

/** Preserve the admitted input identity when a queued or recovered turn gets a new run ID. */
export function resolveReplySourceTurnId(params: {
  sourceTurnId?: string;
  admissionRunId?: string;
  ingressProvider?: string;
  entry?: Pick<SessionEntry, "restartRecoveryDeliveryRunId" | "restartRecoveryDeliverySourceRunId">;
}): string | undefined {
  const sourceTurnId = normalizeOptionalString(params.sourceTurnId);
  if (sourceTurnId) {
    return sourceTurnId;
  }
  const admissionRunId = normalizeOptionalString(params.admissionRunId);
  if (!admissionRunId || !isInternalMessageChannel(params.ingressProvider)) {
    return undefined;
  }
  return params.entry?.restartRecoveryDeliveryRunId === admissionRunId
    ? (normalizeOptionalString(params.entry.restartRecoveryDeliverySourceRunId) ?? admissionRunId)
    : admissionRunId;
}

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

/** Carries host-only source identity through internal context clones without public type drift. */
export function setChannelSourceTurnId(context: object, sourceTurnId: string | undefined): void {
  const scoped = context as ChannelSourceTurnContext;
  if (sourceTurnId) {
    scoped[CHANNEL_SOURCE_TURN_ID] = sourceTurnId;
  } else {
    delete scoped[CHANNEL_SOURCE_TURN_ID];
  }
}

export function readChannelSourceTurnId(context: object): string | undefined {
  return (context as ChannelSourceTurnContext)[CHANNEL_SOURCE_TURN_ID];
}

/** Carries the original channel adapter's narrowed message-action scope privately. */
export function setChannelSourceTurnSameThreadRequired(
  context: object,
  sameThreadRequired: boolean | undefined,
): void {
  const scoped = context as ChannelSourceTurnContext;
  if (sameThreadRequired === true) {
    scoped[CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED] = true;
  } else {
    delete scoped[CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED];
  }
}

export function readChannelSourceTurnSameThreadRequired(context: object): boolean {
  return (context as ChannelSourceTurnContext)[CHANNEL_SOURCE_TURN_SAME_THREAD_REQUIRED] === true;
}
