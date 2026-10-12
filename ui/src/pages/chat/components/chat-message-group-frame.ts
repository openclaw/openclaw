import type { JSX } from "@solidjs/web";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import {
  normalizeRoleForGrouping,
  resolveMessageRole,
} from "../../../lib/chat/message-normalizer.ts";
import { readToolApprovalReviews } from "../../../lib/chat/tool-approval-reviews.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { gatewayClientKind } from "../../../lib/gateway-client-kind.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { DEFAULT_AGENT_ID } from "../../../lib/sessions/session-key.ts";
import { resolveAssistantReplyPhase } from "../chat-assistant-reply.ts";
import { readPendingSendStatus } from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import type { RenderMessageGroupOptions } from "./chat-message-group-options.ts";
import {
  FULL_MESSAGE_RETRY_REVISION_LIMIT,
  hasMessageActionButtons,
  prepareChatMessageRender,
  resolveMessageActionDetails,
} from "./chat-message-markdown-view.tsx";
import {
  isOwnSenderGroup,
  isSourceOnlyUserGroup,
  resolveMessageGroupSenderLabel,
} from "./chat-message-sender.ts";
import { extractGroupMeta } from "./chat-message-timestamp-view.tsx";
import { NO_REPLY_LINE, resolveGroupReplyLine } from "./chat-reply-attribution.ts";

export type NativeMessageGroupOptions = Omit<
  RenderMessageGroupOptions,
  "frameContent" | "avatar"
> & {
  frameContent?: JSX.Element[];
  avatar?: GroupedMessageOptions["avatar"];
};

export type GroupMessage = MessageGroupData["messages"][number];

export function prepareGroupMessage(
  group: MessageGroupData,
  item: MessageGroupData["messages"][number],
  opts: NativeMessageGroupOptions,
) {
  const source = prepareChatMessageRender(item.message);
  const details = resolveMessageActionDetails(source, {
    ...opts,
    messageId: item.key,
    canFetchFullMessage: Boolean(opts.loadFullAssistantMessage && opts.sessionKey),
    senderLabel: resolveMessageGroupSenderLabel(group, opts),
  });
  const messageId = details?.fullMessage?.messageId;
  if (messageId) {
    // Projected rows can share a source ID; a preceding row may have started its load.
    const expansion = opts.getAssistantMessageExpansion?.(messageId);
    // Retry transient failures on later renders, bounded so a dead loader cannot hot-loop.
    if (
      !expansion ||
      (expansion.status === "error" && expansion.revision < FULL_MESSAGE_RETRY_REVISION_LIMIT)
    ) {
      opts.onToggleAssistantMessageExpanded?.(messageId);
    }
  }
  return { item, source, actions: details };
}

export function isActivityMessageGroup(group: MessageGroupData, bubbleMode = false): boolean {
  if (normalizeRoleForGrouping(group.role) !== "tool") {
    return false;
  }
  if (
    bubbleMode &&
    group.messages.some(
      (item) => item.hasVisibleContent && resolveMessageRole(item.message) === "assistant",
    )
  ) {
    return false;
  }
  const cards = group.messages.flatMap((item) => extractToolCardsCached(item.message));
  return (
    bubbleMode ||
    group.messages.length > 1 ||
    cards.length > 1 ||
    cards.some((card) => readToolApprovalReviews(card.details).length > 0)
  );
}

export function resolveFileLinkOwnerOptions(
  group: MessageGroupData,
  options: NativeMessageGroupOptions,
) {
  const sourceSessionKey = group.senderSession?.sessionKey;
  const owned: NativeMessageGroupOptions = sourceSessionKey
    ? {
        ...options,
        fileLinkSessionKey: sourceSessionKey,
        onOpenWorkspaceFile:
          options.onOpenWorkspaceFile &&
          ((target) => {
            const ownedTarget = { ...target, sessionKey: sourceSessionKey };
            options.onOpenWorkspaceFile?.(ownedTarget);
          }),
        onOpenSidebar:
          options.onOpenSidebar &&
          ((content) =>
            options.onOpenSidebar?.(
              content.kind === "markdown"
                ? { ...content, fileLinkSessionKey: sourceSessionKey }
                : content,
            )),
      }
    : options;
  return owned;
}

export function prepareMessageGroupFrame(
  group: MessageGroupData,
  options: NativeMessageGroupOptions,
) {
  const sourceSessionKey = group.senderSession?.sessionKey;
  const opts = resolveFileLinkOwnerOptions(group, options);
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const sourceOnly = isSourceOnlyUserGroup(group);
  const showAvatar =
    normalizedRole !== "user" || Boolean(group.sender || group.senderLabel?.trim());
  const assistantName = opts.assistantName ?? "Assistant";
  const isOwnGroup = isOwnSenderGroup(group, opts.userId);
  const isPeerGroup =
    normalizedRole === "user" && Boolean(opts.userId && group.sender) && !isOwnGroup;
  const forwardedSource = hasForwardedSource(group);
  const isForwarded = normalizedRole === "assistant" && forwardedSource;
  const replyLine = opts.frameContent
    ? (opts.frameReplyLine ?? NO_REPLY_LINE)
    : resolveGroupReplyLine(group, opts.resolveReplyPreview);
  // Only a strip naming this same participant replaces the sender label; a
  // shared display name does not. An assistant group is its agent's identity;
  // a user group without a typed identity has none to compare, so it keeps its name.
  const ownIdentity =
    group.sender?.identity ??
    (normalizedRole === "assistant"
      ? {
          type: "agent" as const,
          id: group.senderSession?.agentId ?? opts.agentId ?? DEFAULT_AGENT_ID,
        }
      : undefined);
  const replyIdentity = replyLine.sender?.identity;
  const showSenderName =
    !(
      ownIdentity &&
      replyIdentity?.type === ownIdentity.type &&
      replyIdentity.id === ownIdentity.id
    ) &&
    !isForwarded &&
    !sourceOnly &&
    (normalizedRole !== "user" || !isOwnGroup || opts.showOwnSenderName !== false);
  const visibleSources = group.sourceClients?.filter(
    (source) => gatewayClientKind(source) !== "web",
  );
  const who = resolveMessageGroupSenderLabel(group, opts);
  const roleClass =
    normalizedRole === "user" || normalizedRole === "assistant" || normalizedRole === "tool"
      ? normalizedRole
      : group.messages.every((item) => workspaceResultConflictFromTranscript(item.message))
        ? "workspace-conflict"
        : "other";
  const avatarPlacement = opts.avatarPlacement ?? "gutter";
  const meta = extractGroupMeta(group, opts.contextWindow ?? null);

  const ownsRunFrame = opts.frameContent !== undefined;
  // Tool activity and live narration are blocks of the turn whose answer follows:
  // no identity, footer or actions of their own, only the run-block gap.
  const isTurnBlock =
    normalizedRole === "tool" ||
    (normalizedRole === "assistant" &&
      !opts.searchResult &&
      !ownsRunFrame &&
      !isForwarded &&
      resolveAssistantReplyPhase(group.messages[0]?.message) === "commentary");
  const actionOwners = ownsRunFrame
    ? opts.frameActionOwner
      ? [opts.frameActionOwner]
      : []
    : group.messages;
  const preparedMessages = actionOwners.map((item) => prepareGroupMessage(group, item, opts));
  const lastMessageIndex = group.messages.length - 1;
  const footerActionDetails = preparedMessages.at(-1)?.actions ?? null;
  const footerActionMessageKey = actionOwners.at(-1)?.key;
  const hasUserFooterActions =
    normalizedRole === "user" &&
    ((opts.onRewind && !opts.rewindDisabled) || hasMessageActionButtons(footerActionDetails, opts));
  // Source sessions share the stable sender hue machinery; CSS owns contrast
  // in each theme. Unattributed local messages keep the accent skin.
  const senderHue =
    isForwarded && sourceSessionKey
      ? resolveIdentityHue({ id: sourceSessionKey })
      : normalizedRole === "user" && group.sender
        ? resolveIdentityHue(group.sender)
        : null;
  const sendStatus = readPendingSendStatus(group.messages.at(-1)?.message);

  const inlineUserAvatar =
    normalizedRole === "user" &&
    avatarPlacement === "gutter" &&
    (isPeerGroup || Boolean(preparedMessages[lastMessageIndex]?.source.displayMarkdown));
  const hasAvatar =
    showAvatar &&
    !isTurnBlock &&
    avatarPlacement === "gutter" &&
    (isForwarded || normalizedRole !== "assistant" || opts.showAssistantAvatar !== false);
  const holdsReplyRow = replyLine.state !== "hidden" && hasAvatar;
  return {
    group,
    options: opts,
    normalizedRole,
    showAvatar,
    assistantName,
    isOwnGroup,
    isPeerGroup,
    forwardedSource,
    isForwarded,
    replyLine,
    showSenderName,
    visibleSources,
    who,
    avatarPlacement,
    meta,
    ownsRunFrame,
    isTurnBlock,
    preparedMessages,
    lastMessageIndex,
    footerActionDetails,
    footerActionMessageKey,
    hasUserFooterActions,
    sendStatus,
    inlineUserAvatar,
    hasAvatar,
    className: [
      "chat-group",
      roleClass,
      "chat-group--with-footer",
      {
        "chat-group--turn-block": isTurnBlock,
        "chat-group--latest-assistant": opts.latestAssistant,
        "chat-group--peer": isPeerGroup,
        "chat-group--forwarded": isForwarded,
        "chat-group--sender-tint": senderHue !== null,
        "chat-group--reply": holdsReplyRow,
      },
    ],
    style: senderHue === null ? undefined : `--chat-sender-hue: ${senderHue}`,
    sessionKey: sourceSessionKey ?? undefined,
  };
}

export type MessageGroupFrame = ReturnType<typeof prepareMessageGroupFrame>;
