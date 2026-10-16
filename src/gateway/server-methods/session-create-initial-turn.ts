import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeRpcAttachmentsToChatAttachments,
  type RpcAttachmentInput,
} from "./attachment-normalize.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export function resolveSessionCreateInitialTurn(params: {
  attachments?: unknown[];
  message?: unknown;
  task?: unknown;
}) {
  const message = readNonBlankString(params.task) ?? readNonBlankString(params.message);
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    params.attachments as RpcAttachmentInput[] | undefined,
  );
  if (params.attachments?.length && !message && normalizedAttachments.length === 0) {
    return null;
  }
  const attachments = normalizedAttachments.length ? normalizedAttachments : undefined;
  return {
    attachments,
    hasInitialTurn: message !== undefined || attachments !== undefined,
    message,
  };
}

export function isFreshChatSendStarted(params: { cached?: boolean; payload: unknown }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

/** Validate the initial turn against the same child identity used by creation. */
export async function validateSessionCreateInitialMentions(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  agentId: string;
  sessionKey: string;
  message?: string;
  mentions: NonNullable<SessionsCreateParams["mentions"]>;
  visibility: SessionsCreateParams["visibility"];
  runId: string;
}): Promise<ErrorShape | undefined> {
  const { client, context, agentId, sessionKey, message, mentions, visibility, runId } = params;
  const normalization = normalizeChatSendRequest({
    params: {
      sessionKey,
      message: message ?? "",
      mentions,
      idempotencyKey: runId,
    },
    client,
  });
  const normalized = normalization instanceof Promise ? await normalization : normalization;
  if (!normalized.ok) {
    return errorShape(ErrorCodes.INVALID_REQUEST, normalized.error);
  }
  const eligible = await context.mentionInbox?.validateRecipientsAsync(
    client,
    { agentId, ...(visibility ? { visibility } : {}) },
    mentions.map((mention) => mention.profileId),
  );
  if (!eligible?.ok) {
    return (
      eligible?.error ??
      errorShape(ErrorCodes.UNAVAILABLE, "Human mentions are unavailable; reconnect and retry.")
    );
  }
  return undefined;
}
