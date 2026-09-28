import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  sanitizeExecApprovalDisplayTextWithStatus,
  sanitizeExecApprovalWarningTextWithStatus,
} from "../../infra/exec-approval-text-sanitize.js";
import type { PluginApprovalSource } from "../../infra/plugin-approvals.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { TemplateContext } from "../templating.js";

const MAX_APPROVAL_MESSAGE_EXCERPT_LENGTH = 320;
const MAX_APPROVAL_SENDER_NAME_LENGTH = 80;
const MAX_APPROVAL_CHANNEL_LENGTH = 32;
const MAX_APPROVAL_SENDER_ID_LENGTH = 255;
const MAX_APPROVAL_IDENTIFIER_LENGTH = 64;

function boundedDisplayIdentifier(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value || value.length > maxLength) {
    return undefined;
  }
  const sanitized = sanitizeExecApprovalDisplayTextWithStatus(value);
  if (sanitized.oversized || sanitized.text !== value) {
    return undefined;
  }
  return value.trim() || undefined;
}

/** Snapshot channel-owned display context before queued turns can rewrite it. */
export function capturePluginApprovalSource(params: {
  context: Pick<
    TemplateContext,
    "InboundAccessAuthorized" | "SenderIsSelf" | "ApprovalSource" | "RawBody"
  >;
  channel?: string;
  provenance?: InputProvenance;
  isHeartbeat: boolean;
  isRoomEvent: boolean;
  reusesTurnRecorder: boolean;
}): PluginApprovalSource | undefined {
  const { context } = params;
  const source = context.ApprovalSource;
  const channel = boundedDisplayIdentifier(source?.channel, MAX_APPROVAL_CHANNEL_LENGTH);
  const senderId = boundedDisplayIdentifier(source?.senderId, MAX_APPROVAL_SENDER_ID_LENGTH);
  if (
    !source ||
    !channel ||
    channel !== params.channel ||
    !senderId ||
    context.InboundAccessAuthorized !== true ||
    context.SenderIsSelf === true ||
    params.isHeartbeat ||
    params.isRoomEvent ||
    params.reusesTurnRecorder ||
    (params.provenance && params.provenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const rawBody = source.includeUserMessageExcerpt ? context.RawBody : undefined;
  const sanitized = rawBody ? sanitizeExecApprovalWarningTextWithStatus(rawBody) : undefined;
  const displayText = sanitized && !sanitized.oversized ? sanitized.text.trim() : "";
  const userMessageExcerpt =
    displayText.length > MAX_APPROVAL_MESSAGE_EXCERPT_LENGTH
      ? `${truncateUtf16Safe(displayText, MAX_APPROVAL_MESSAGE_EXCERPT_LENGTH - 1)}…`
      : displayText;
  const sanitizedName = source.senderName
    ? sanitizeExecApprovalDisplayTextWithStatus(source.senderName)
    : undefined;
  const displayName = sanitizedName && !sanitizedName.oversized ? sanitizedName.text.trim() : "";
  const senderName =
    displayName.length > MAX_APPROVAL_SENDER_NAME_LENGTH
      ? `${truncateUtf16Safe(displayName, MAX_APPROVAL_SENDER_NAME_LENGTH - 1)}…`
      : displayName;
  const workspaceId = boundedDisplayIdentifier(source.workspaceId, MAX_APPROVAL_IDENTIFIER_LENGTH);
  return {
    channel,
    senderId,
    ...(senderName && senderName !== senderId ? { senderName } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(source.conversationKind ? { conversationKind: source.conversationKind } : {}),
    ...(userMessageExcerpt ? { userMessageExcerpt } : {}),
  };
}
