import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { groupToolCalls, type ToolCallGroup } from "../../../../../src/chat/tool-call-grouping.js";
import { resolveLocalUserName } from "../../../app/user-identity.ts";
import type { BrowserTabSelection } from "../../../components/browser/browser-target.ts";
import { icons } from "../../../components/icons.ts";
import {
  personActivityLink,
  renderPersonName,
  type PersonActivityRouting,
} from "../../../components/person-activity-link.ts";
import { t } from "../../../i18n/index.ts";
import type { MessageGroup, ToolCard } from "../../../lib/chat/chat-types.ts";
import { messageClientSourcesLabel } from "../../../lib/chat/message-client-source.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import {
  readToolApprovalReviewOutcome,
  readToolApprovalReviews,
  resolveToolApprovalReviewOutcome,
} from "../../../lib/chat/tool-approval-reviews.ts";
import { summarizeToolGroup, readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { gatewayClientKind } from "../../../lib/gateway-client-kind.ts";
import { resolveIdentityHue } from "../../../lib/identity-avatar.ts";
import { resolveAssistantReplyPhase } from "../chat-assistant-reply.ts";
import { renderChatAvatar, renderForwardedAvatar } from "../chat-avatar.ts";
import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";
import type { TurnRecap } from "../chat-progress.ts";
import { persistedMessageEntryId, readPendingSendStatus } from "../chat-thread.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import { workspaceResultConflictFromTranscript } from "../workspace-conflict.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderForwardedAttribution } from "./chat-forwarded-attribution.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderRewindButton } from "./chat-message-confirmation.ts";
import {
  FULL_MESSAGE_RETRY_REVISION_LIMIT,
  renderMessageActionButtons,
  renderReplyButton,
  prepareChatMessageRender,
  resolveMessageActionDetails,
  type MessageReplyTarget,
} from "./chat-message-markdown.ts";
import { renderChatSendStatus, type ChatSendStatusActions } from "./chat-message-send-status.ts";
import {
  emptyGroupFooter,
  renderStreamGroupParts,
  type StreamGroupOptions,
  type StreamGroupPart,
} from "./chat-message-stream.ts";
import type { AssistantMessageDisclosure } from "./chat-message-text.ts";
import { extractGroupMeta, renderMessageMeta } from "./chat-message-timestamp.ts";
import { renderChatReplyAttribution } from "./chat-reply-attribution.ts";
import type { SidebarContent, SidebarFullMessageLoader } from "./chat-sidebar.ts";
import {
  renderBrowserTabPreviews,
  renderToolCard,
  shouldToggleSelectableDisclosure,
  syncToolDisclosureOverflow,
} from "./chat-tool-cards.ts";
import { renderToolOutcomeSummary } from "./chat-tool-outcome-summary.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

type ActiveContinuation = {
  parts: StreamGroupPart[];
  options: StreamGroupOptions;
};

type ReplyPreview = MessageReplyTarget & { sourceMessageId: string };

type GroupedMessageRenderOptions = Parameters<typeof renderGroupedMessage>[2];

type RenderMessageGroupOptions = Omit<
  GroupedMessageRenderOptions,
  | "isStreaming"
  | "duplicateCount"
  | "assistantMessageDisclosure"
  | "messageActions"
  | "entryId"
  | "entryRef"
  | "resolveReplyPreview"
> &
  ChatSendStatusActions &
  Parameters<typeof renderForwardedAvatar>[1] & {
    entryRefFor?: (key: string) => ((element?: Element) => void) | undefined;
    latestBrowserTabs?: ReadonlyMap<string, BrowserTabSelection>;
    /** Configured main-session key; an agent's main source labels as the agent. */
    mainKey?: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    loadFullAssistantMessage?: SidebarFullMessageLoader;
    getAssistantMessageExpansion?: (
      messageId: string,
    ) => AssistantMessageExpansionState | undefined;
    onToggleAssistantMessageExpanded?: (messageId: string) => void;
    userId?: string | null;
    userName?: string | null;
    showOwnSenderName?: boolean;
    /** Routing for peer sender names; absent leaves them plain text. */
    personActivity?: PersonActivityRouting;
    userAvatar?: string | null;
    avatarPlacement?: "gutter" | "footer" | "none";
    showAssistantAvatar?: boolean;
    contextWindow?: number | null;
    onReply?: (target: MessageReplyTarget) => void;
    resolveReplyPreview?: (replyToId: string) => ReplyPreview | undefined;
    onRewind?: () => void;
    rewindDisabled?: boolean;
    activeContinuation?: ActiveContinuation;
    turnRecap?: TurnRecap;
    /** Frame bodies are pre-rendered by the frame owner; ordinary groups omit them. */
    frameContent?: readonly unknown[];
    frameActionOwner?: MessageGroup["messages"][number] | null;
    latestAssistant?: boolean;
    /** Rendered as a transcript search result, outside its turn. */
    searchResult?: boolean;
  };

function prepareGroupMessage(
  group: MessageGroup,
  item: MessageGroup["messages"][number],
  opts: RenderMessageGroupOptions,
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

function renderPreparedGroupMessage(
  group: MessageGroup,
  index: number,
  opts: RenderMessageGroupOptions,
  { item, source, actions: actionDetails }: ReturnType<typeof prepareGroupMessage>,
) {
  let assistantMessageDisclosure: AssistantMessageDisclosure | undefined;
  const fullMessage = actionDetails?.fullMessage;
  if (fullMessage && opts.loadFullAssistantMessage && opts.onToggleAssistantMessageExpanded) {
    const { messageId, state: expansion } = fullMessage;
    const retriesExhausted =
      expansion?.status === "error" && expansion.revision >= FULL_MESSAGE_RETRY_REVISION_LIMIT;
    assistantMessageDisclosure = {
      expanded: expansion?.status === "loaded",
      ...(expansion?.status === "loaded"
        ? { markdown: actionDetails?.markdown, message: expansion.message }
        : {}),
      // Manual re-entry once the bounded automatic retries gave up.
      ...(retriesExhausted
        ? { onRetryFullMessage: () => opts.onToggleAssistantMessageExpanded?.(messageId) }
        : {}),
    };
  }
  return renderGroupedMessage(
    source,
    item.key,
    {
      ...opts,
      isStreaming: group.isStreaming && index === group.messages.length - 1,
      entryId: persistedMessageEntryId(item.message) ?? undefined,
      entryRef: opts.entryRefFor?.(item.key),
      duplicateCount: item.duplicateCount ?? 1,
      showToolCalls: opts.showToolCalls ?? true,
      autoExpandToolCalls: opts.autoExpandToolCalls ?? false,
      assistantMessageDisclosure,
      messageActions: actionDetails,
    },
    opts.onOpenSidebar,
  );
}

function isOwnSenderGroup(
  group: Pick<MessageGroup, "sender">,
  userId: string | null | undefined,
): boolean {
  const identity = group.sender?.identity;
  return identity?.type === "profile" && identity.id === userId;
}

export function renderActivityGroup(
  groups: readonly MessageGroup[],
  opts: RenderMessageGroupOptions,
  presentation: "standalone" | "continuation" = "standalone",
) {
  const firstGroup = groups[0];
  if (!firstGroup || opts.showToolCalls === false) {
    return nothing;
  }
  const entries = groups.flatMap((group) => group.messages);
  const cards = entries.flatMap((entry) => extractToolCardsCached(entry.message));
  const preparedByCard = new Map<ToolCard, ReturnType<typeof readPreparedActivity>[number]>();
  const activity = entries.flatMap((entry) => {
    const prepared = readPreparedActivity(entry.message);
    const byCallId = new Map(prepared.map((item) => [item.toolCallId, item]));
    for (const card of extractToolCardsCached(entry.message)) {
      const item = card.callId ? byCallId.get(card.callId) : undefined;
      if (item) {
        preparedByCard.set(card, item);
      }
    }
    return prepared;
  });
  const visibleActivity = activity.filter(
    (item) => !item.hideFromChannelProgress && !item.suppressChannelProgress,
  );
  const running = opts.runActive
    ? visibleActivity.findLast((item) => item.status === "running")
    : undefined;
  const cardGroups = groupToolCalls(cards);
  let runningOperation = running;
  if (running?.toolCallId) {
    const runningCard = cards.findLast((card) => preparedByCard.get(card) === running);
    for (const root of cardGroups) {
      const pending = [...root.children];
      for (const child of pending) {
        if (child.card === runningCard) {
          // Recorded nesting chooses the owner; only its prepared item supplies copy.
          const parentActivity = preparedByCard.get(root.card);
          if (
            parentActivity &&
            !parentActivity.hideFromChannelProgress &&
            !parentActivity.suppressChannelProgress
          ) {
            runningOperation = parentActivity;
          }
        }
        pending.push(...child.children);
      }
    }
  }
  const visibleCalls = new Set(visibleActivity.map((item) => item.toolCallId ?? item.itemId));
  const activityDisclosureId = `activity:${firstGroup.key}`;
  const activityBodyId = `activity-body-${fnv1aUtf16(firstGroup.key).toString(16)}`;
  const activityExpanded = opts.isToolMessageExpanded?.(activityDisclosureId) ?? false;
  const groupSummaryLabel = runningOperation
    ? `${runningOperation.title}…`
    : summarizeToolGroup(visibleActivity, { includeFailureCount: activityExpanded });
  const toolCardOverrides = new Map<ToolCard, unknown>();
  const toolContexts = new Map(
    groups.flatMap((group) =>
      group.messages.flatMap((item) =>
        extractToolCardsCached(item.message).map(
          (card, index) =>
            [
              card,
              {
                messageKey: item.key,
                disclosureId: `${item.key}:toolcard:${index}`,
              },
            ] as const,
        ),
      ),
    ),
  );
  function renderOperation(group: ToolCallGroup<ToolCard>): unknown {
    const { card, children } = group;
    const context = toolContexts.get(card)!;
    const expanded = opts.isToolExpanded?.(context.disclosureId) ?? false;
    const descendants: ToolCard[] = [];
    const pending = [...children];
    for (const child of pending) {
      descendants.push(child.card);
      pending.push(...child.children);
      toolCardOverrides.set(child.card, nothing);
    }
    return renderToolCard(card, {
      ...opts,
      messageKey: context.messageKey,
      expanded,
      onToggleExpanded: () => opts.onToggleToolExpanded?.(context.disclosureId, expanded),
      activityCards: [card, ...descendants],
      children: children.length
        ? html`${expanded ? children.map(renderOperation) : nothing}`
        : undefined,
    });
  }
  if (activityExpanded) {
    for (const group of cardGroups) {
      if (group.children.length > 0) {
        toolCardOverrides.set(group.card, renderOperation(group));
      }
    }
  }
  const approvalReviews = cards.flatMap((card) => readToolApprovalReviews(card.details));
  const recordedReviewOutcomes = cards.flatMap((card) => {
    const outcome = readToolApprovalReviewOutcome(card.details);
    return outcome ? [outcome] : [];
  });
  const reviewOutcome = resolveToolApprovalReviewOutcome(approvalReviews, recordedReviewOutcomes);
  const reviewer = approvalReviews[0]?.label ?? "Review";
  const reviewAriaLabel = reviewOutcome
    ? t(`chat.toolCards.review.${reviewOutcome === "reviewing" ? "reviewing" : reviewOutcome}`, {
        reviewer,
      })
    : "";
  const content = html`
    <div class="chat-activity-group ${activityExpanded ? "is-open" : ""}">
      <button
        class="chat-inline-disclosure chat-activity-group__summary"
        type="button"
        aria-expanded=${String(activityExpanded)}
        aria-controls=${activityBodyId}
        @pointerenter=${syncToolDisclosureOverflow}
        @focus=${syncToolDisclosureOverflow}
        @click=${(event: MouseEvent) => {
          if (shouldToggleSelectableDisclosure(event)) {
            opts.onToggleToolMessageExpanded?.(activityDisclosureId, activityExpanded);
          }
        }}
      >
        <span class="chat-activity-group__icon">${icons.listTree}</span>
        <span class="chat-tool-disclosure__content">
          <span class="chat-activity-group__label">${groupSummaryLabel}</span>
        </span>
        ${
          reviewOutcome
            ? html`<span
                class="chat-activity-group__review-status"
                data-outcome=${reviewOutcome}
                role="img"
                aria-label=${reviewAriaLabel}
                >${
                  reviewOutcome === "denied"
                    ? icons.shieldX
                    : reviewOutcome === "reviewing"
                      ? icons.shieldQuestion
                      : icons.shieldCheck
                }</span
              >`
            : nothing
        }
        ${
          activityExpanded
            ? nothing
            : renderToolOutcomeSummary(
                cards.filter((card) => card.callId && visibleCalls.has(card.callId)),
                true,
                visibleActivity,
              )
        }
        <span class="chat-tool-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
      </button>
      <div class="chat-activity-group__body" id=${activityBodyId} ?hidden=${!activityExpanded}>
        ${
          activityExpanded
            ? groups.map((group) =>
                group.messages.map((item, index) =>
                  renderPreparedGroupMessage(
                    group,
                    index,
                    { ...opts, toolCardOverrides },
                    prepareGroupMessage(group, item, opts),
                  ),
                ),
              )
            : nothing
        }
      </div>
      ${renderBrowserTabPreviews(groups, opts)}
    </div>
  `;
  return presentation === "continuation"
    ? content
    : html`
        <div
          class="chat-group tool chat-group--turn-block chat-group--activity chat-group--with-footer"
          data-chat-row-key=${firstGroup.key}
        >
          <div class="chat-group-messages">${content}</div>
        </div>
      `;
}

function isSourceOnlyUserGroup(
  group: Pick<MessageGroup, "role" | "sender" | "senderLabel" | "sourceClients">,
): boolean {
  return (
    normalizeRoleForGrouping(group.role) === "user" &&
    Boolean(group.sourceClients?.length) &&
    !group.sender &&
    !group.senderLabel?.trim()
  );
}

export function resolveMessageGroupSenderLabel(
  group: Pick<MessageGroup, "role" | "sender" | "senderLabel" | "sourceClients"> & {
    messages: ReadonlyArray<{ message: unknown }>;
  },
  opts: Pick<RenderMessageGroupOptions, "assistantName" | "userId" | "userName">,
): string {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  if (isSourceOnlyUserGroup(group)) {
    return messageClientSourcesLabel(group.sourceClients ?? []);
  }
  if (normalizedRole === "custom") {
    const isError = group.messages.every(({ message }) => {
      const customType = asNullableRecord(message)?.customType;
      return (
        customType === "run-failed-before-reply" || customType === "cloud-workspace-recovery-failed"
      );
    });
    if (isError) {
      const isContention = group.messages.every(({ message }) => {
        const entry = asNullableRecord(message);
        return (
          entry?.customType === "run-failed-before-reply" &&
          asNullableRecord(entry.details)?.errorKind === "state_contention"
        );
      });
      return t(isContention ? "common.system" : "chat.messages.errorSender");
    }
    return group.messages.every(({ message }) => workspaceResultConflictFromTranscript(message))
      ? t("chat.workspaceConflict.eventSender")
      : t("common.system");
  }
  const resolvedUserName = resolveLocalUserName({ name: opts.userName });
  const userLabel = group.senderLabel?.trim();
  return normalizedRole === "user"
    ? isOwnSenderGroup(group, opts.userId)
      ? resolvedUserName
      : (userLabel ?? resolvedUserName)
    : normalizedRole === "assistant"
      ? (userLabel ?? opts.assistantName ?? "Assistant")
      : normalizedRole === "tool"
        ? t("chat.messages.toolSender")
        : normalizedRole;
}

function isActivityMessageGroup(group: MessageGroup): boolean {
  if (normalizeRoleForGrouping(group.role) !== "tool") {
    return false;
  }
  const cards = group.messages.flatMap((item) => extractToolCardsCached(item.message));
  return (
    group.messages.length > 1 ||
    cards.length > 1 ||
    cards.some((card) => readToolApprovalReviews(card.details).length > 0)
  );
}

export function renderMessageGroupContent(group: MessageGroup, opts: RenderMessageGroupOptions) {
  if (isActivityMessageGroup(group)) {
    return renderActivityGroup([group], opts, "continuation");
  }
  const messageOptions = { ...opts, isForwarded: hasForwardedSource(group) };
  const messages = repeat(
    group.messages,
    (item) => item.key,
    (item, index) =>
      renderPreparedGroupMessage(
        group,
        index,
        messageOptions,
        prepareGroupMessage(group, item, opts),
      ),
  );
  return html`${messages}${
    opts.showToolCalls === false ? nothing : renderBrowserTabPreviews([group], opts)
  }`;
}

export function renderMessageGroup(group: MessageGroup, opts: RenderMessageGroupOptions) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const sourceOnly = isSourceOnlyUserGroup(group);
  const assistantName = opts.assistantName ?? "Assistant";
  const isPeerGroup =
    normalizedRole === "user" &&
    Boolean(opts.userId && group.sender) &&
    !isOwnSenderGroup(group, opts.userId);
  const forwardedSource = hasForwardedSource(group);
  const isForwarded = normalizedRole === "assistant" && forwardedSource;
  const showSenderName =
    !isForwarded &&
    !sourceOnly &&
    (normalizedRole !== "user" || isPeerGroup || opts.showOwnSenderName !== false);
  const visibleSources = group.sourceClients?.filter(
    (source) => gatewayClientKind(source) !== "web",
  );
  const sourceSessionKey = group.senderSession?.sessionKey;
  const who = resolveMessageGroupSenderLabel(group, opts);
  const roleClass =
    normalizedRole === "user" || normalizedRole === "assistant" || normalizedRole === "tool"
      ? normalizedRole
      : group.messages.every((item) => workspaceResultConflictFromTranscript(item.message))
        ? "workspace-conflict"
        : "other";
  const avatarPlacement = opts.avatarPlacement ?? "gutter";

  // Aggregate usage/cost/model across all messages in the group
  const meta = extractGroupMeta(group, opts.contextWindow ?? null);

  if (normalizedRole === "tool" && opts.showToolCalls === false) {
    return nothing;
  }

  if (isActivityMessageGroup(group)) {
    return renderActivityGroup([group], opts);
  }

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
  const footerActionDetails = ownsRunFrame
    ? (preparedMessages[0]?.actions ?? null)
    : (preparedMessages[lastMessageIndex]?.actions ?? null);
  const footerActionMessageKey = ownsRunFrame
    ? opts.frameActionOwner?.key
    : group.messages[lastMessageIndex]?.key;
  const hasUserFooterActions =
    normalizedRole === "user" &&
    Boolean(
      (footerActionDetails?.replyTarget && opts.onReply) ||
      (opts.onRewind && !opts.rewindDisabled) ||
      footerActionDetails?.markdown,
    );
  const userFooterActions = hasUserFooterActions
    ? html`
        <div
          class="chat-group-footer-actions"
          data-message-actions-for=${footerActionMessageKey ?? nothing}
        >
          ${
            footerActionDetails?.replyTarget && opts.onReply
              ? renderReplyButton(footerActionDetails.replyTarget, opts.onReply)
              : nothing
          }
          ${opts.onRewind && !opts.rewindDisabled ? renderRewindButton(opts.onRewind) : nothing}
          ${
            footerActionDetails?.markdown
              ? renderMessageActionButtons(footerActionDetails, {})
              : nothing
          }
        </div>
      `
    : nothing;

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
    Boolean(preparedMessages[lastMessageIndex]?.source.displayMarkdown);
  const avatar =
    !sourceOnly &&
    !isTurnBlock &&
    avatarPlacement === "gutter" &&
    (isForwarded || normalizedRole !== "assistant" || opts.showAssistantAvatar !== false)
      ? isForwarded
        ? renderForwardedAvatar(group.senderSession?.agentId, opts)
        : renderChatAvatar(
            group.role,
            {
              agentId: opts.agentId,
              name: assistantName,
              avatar: opts.assistantAvatar ?? null,
              textAvatar: opts.assistantTextAvatar,
            },
            { name: opts.userName ?? null, avatar: opts.userAvatar ?? null },
            group.sender,
          )
      : nothing;

  return html`
    <div
      class="chat-group ${roleClass} chat-group--with-footer${
        isTurnBlock ? " chat-group--turn-block" : ""
      }${
        opts.latestAssistant ? " chat-group--latest-assistant" : ""
      }${isPeerGroup ? " chat-group--peer" : ""}${
        isForwarded ? " chat-group--forwarded" : ""
      }${senderHue === null ? "" : " chat-group--sender-tint"}"
      style=${senderHue === null ? nothing : `--chat-sender-hue: ${senderHue}`}
      data-chat-row-key=${group.key}
    >
      ${inlineUserAvatar ? nothing : avatar}
      <div class="chat-group-messages">
        ${forwardedSource ? renderForwardedAttribution(group, opts) : nothing}
        ${normalizedRole === "assistant" ? renderChatReplyAttribution(group.replyToSender) : nothing}
        ${
          opts.frameContent ??
          repeat(
            preparedMessages,
            (prepared) => prepared.item.key,
            (prepared, index) => {
              const { item, actions: actionDetails } = prepared;
              return html`
                ${renderPreparedGroupMessage(
                  group,
                  index,
                  {
                    ...opts,
                    isForwarded: forwardedSource,
                    avatar: inlineUserAvatar && index === lastMessageIndex ? avatar : undefined,
                  },
                  prepared,
                )}
                ${
                  actionDetails &&
                  (actionDetails.markdown || (actionDetails.replyTarget && opts.onReply)) &&
                  index < lastMessageIndex &&
                  !ownsRunFrame &&
                  !isTurnBlock
                    ? html`
                        <div class="chat-message-actions-row" data-message-actions-for=${item.key}>
                          ${renderMessageActionButtons(actionDetails, opts)}
                        </div>
                      `
                    : nothing
                }
              `;
            },
          )
        }
        ${
          ownsRunFrame || opts.showToolCalls === false
            ? nothing
            : renderBrowserTabPreviews([group], opts)
        }
        ${
          opts.activeContinuation
            ? renderStreamGroupParts(
                opts.activeContinuation.parts,
                opts.activeContinuation.options,
                "continuation",
              )
            : opts.turnRecap
              ? renderTurnRecapRow(opts.turnRecap, { presentation: "continuation" })
              : nothing
        }
      </div>
      ${
        isTurnBlock
          ? nothing
          : group.isStreaming || opts.activeContinuation
            ? emptyGroupFooter
            : html`<div
                class="chat-group-footer ${
                  normalizedRole === "user" &&
                  (visibleSources?.length ||
                    isPeerGroup ||
                    (showSenderName && avatarPlacement !== "footer"))
                    ? "chat-group-footer--persistent-identity"
                    : ""
                }${sendStatus ? " chat-group-footer--send-status" : ""}"
              >
                ${isPeerGroup ? nothing : userFooterActions}
                <div class="chat-group-footer__meta">
                  ${
                    normalizedRole === "user" && !sourceOnly && avatarPlacement === "footer"
                      ? renderChatAuthorAvatar(group.sender)
                      : nothing
                  }
                  ${
                    !showSenderName
                      ? nothing
                      : renderPersonName(
                          who,
                          // Only other people's messages: your own name links nowhere useful.
                          isPeerGroup && group.sender?.identity?.type === "profile"
                            ? personActivityLink(group.sender.identity.id, opts.personActivity, who)
                            : null,
                          "chat-sender-name",
                        )
                  }
                  ${
                    visibleSources?.length
                      ? html`<span class="chat-message-source"
                          >${messageClientSourcesLabel(visibleSources)}</span
                        >`
                      : nothing
                  }
                  ${renderChatSendStatus(sendStatus, opts)}
                  ${renderMessageMeta(group.timestamp, meta)}
                </div>
                ${
                  isPeerGroup
                    ? userFooterActions
                    : normalizedRole !== "user" && footerActionDetails
                      ? html`
                          <div
                            class="chat-group-footer-actions"
                            data-message-actions-for=${footerActionMessageKey ?? nothing}
                          >
                            ${renderMessageActionButtons(footerActionDetails, opts)}
                          </div>
                        `
                      : nothing
                }
              </div>`
      }
    </div>
  `;
}
