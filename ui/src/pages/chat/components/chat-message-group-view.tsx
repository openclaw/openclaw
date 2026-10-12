import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { personActivityLink, renderPersonName } from "../../../components/person-activity-link.ts";
import type { MessageGroup as MessageGroupData } from "../../../lib/chat/chat-types.ts";
import { messageClientSourcesLabel } from "../../../lib/chat/message-client-source.ts";
import { normalizeRoleForGrouping } from "../../../lib/chat/message-normalizer.ts";
import { emptyLegacyContent as litNothing, LitContent } from "../../../lit/solid-content.tsx";
import { renderChatAvatar, renderForwardedAvatar } from "../chat-avatar.ts";
import { persistedMessageEntryId } from "../chat-thread.ts";
import { hasForwardedSource, isSessionActivityGroup } from "../chat-turn-boundary.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import { renderForwardedAttribution } from "./chat-forwarded-attribution.ts";
import { ActivityGroupContent } from "./chat-message-activity-view.tsx";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import { RewindButton } from "./chat-message-confirmation-view.tsx";
import {
  type GroupMessage,
  type MessageGroupFrame,
  type NativeMessageGroupOptions,
  isActivityMessageGroup,
  prepareGroupMessage,
  prepareMessageGroupFrame,
  resolveFileLinkOwnerOptions,
} from "./chat-message-group-frame.ts";
import {
  FULL_MESSAGE_RETRY_REVISION_LIMIT,
  hasMessageActionButtons,
  MessageActions,
  ReplyButton,
} from "./chat-message-markdown-view.tsx";
import type { MessageActionDetails } from "./chat-message-markdown.types.ts";
import { GroupMessageReactions } from "./chat-message-reaction-chips-view.tsx";
import { messageReactionOptions } from "./chat-message-reaction-model.ts";
import { ChatSendStatus } from "./chat-message-send-status-view.tsx";
import { renderSolidEmptyGroupFooter, StreamGroupParts } from "./chat-message-stream-view.tsx";
import type { AssistantMessageDisclosure } from "./chat-message-text-view.tsx";
import { MessageMeta } from "./chat-message-timestamp-view.tsx";
import {
  NO_REPLY_LINE,
  renderReplyLine,
  renderReplyLineConnector,
  resolveGroupReplyLine,
  resolveMessageReplyLine,
} from "./chat-reply-attribution.ts";
import { ChatSessionActivity } from "./chat-session-activity.solid.tsx";
import { renderBrowserTabPreviews } from "./chat-tool-cards.ts";
import { renderTurnRecapRow } from "./chat-working-indicator.ts";

export type { NativeMessageGroupOptions } from "./chat-message-group-frame.ts";

function MessageActionsRow(props: {
  messageKey?: string;
  details: MessageActionDetails | null | undefined;
  options: NativeMessageGroupOptions;
  class?: string;
}) {
  return (
    <div
      class={props.class ?? "chat-group-footer-actions"}
      data-message-actions-for={props.messageKey}
    >
      <MessageActions details={props.details} options={props.options} />
    </div>
  );
}

function PreparedMessage(props: {
  group: MessageGroupData;
  item: GroupMessage;
  index: number;
  options: NativeMessageGroupOptions & Pick<GroupedMessageOptions, "replyLine">;
  prepared?: ReturnType<typeof prepareGroupMessage>;
}) {
  const prepared = createMemo(
    () => props.prepared ?? prepareGroupMessage(props.group, props.item, props.options),
  );
  const isStreaming = () =>
    props.group.isStreaming && props.index === props.group.messages.length - 1;
  const options = createMemo(() => {
    const actionDetails = prepared().actions;
    let assistantMessageDisclosure: AssistantMessageDisclosure | undefined;
    const fullMessage = actionDetails?.fullMessage;
    if (
      fullMessage &&
      props.options.loadFullAssistantMessage &&
      props.options.onToggleAssistantMessageExpanded
    ) {
      const { messageId, state: expansion } = fullMessage;
      const retriesExhausted =
        expansion?.status === "error" && expansion.revision >= FULL_MESSAGE_RETRY_REVISION_LIMIT;
      assistantMessageDisclosure = {
        expanded: expansion?.status === "loaded",
        ...(expansion?.status === "loaded"
          ? { markdown: actionDetails?.markdown, message: expansion.message }
          : {}),
        ...(retriesExhausted
          ? {
              onRetryFullMessage: () => props.options.onToggleAssistantMessageExpanded?.(messageId),
            }
          : {}),
      };
    }
    return {
      ...props.options,
      firstBubbleKey:
        props.options.firstBubbleKey !== undefined
          ? props.options.firstBubbleKey
          : (props.group.messages.find((message) => message.hasVisibleContent)?.key ?? null),
      isStreaming: isStreaming(),
      entryId: persistedMessageEntryId(props.item.message) ?? undefined,
      entryRef: props.options.entryRefFor?.(props.item.key),
      duplicateCount: props.item.duplicateCount ?? 1,
      showToolCalls: props.options.showToolCalls ?? true,
      assistantMessageDisclosure,
      messageActions: actionDetails,
    };
  });
  return (
    <>
      <GroupedMessage
        preparation={prepared().source}
        messageKey={props.item.key}
        options={options()}
        onOpenSidebar={props.options.onOpenSidebar}
      />
      <GroupMessageReactions
        group={props.group}
        actionDetails={prepared().actions}
        isStreaming={isStreaming()}
        options={props.options}
      />
    </>
  );
}

export function renderSolidActivityGroup(
  groups: readonly MessageGroupData[],
  opts: NativeMessageGroupOptions,
  presentation: "standalone" | "continuation" = "standalone",
) {
  return <ActivityGroup groups={groups} options={opts} presentation={presentation} />;
}

export function ActivityGroup(props: {
  groups: readonly MessageGroupData[];
  options: NativeMessageGroupOptions;
  presentation: "standalone" | "continuation";
}) {
  return (
    <ActivityGroupContent
      groups={props.groups}
      options={props.options}
      presentation={props.presentation}
      renderEntries={(overrides) => (
        <For each={props.groups} keyed={(group) => group.key}>
          {(group) => (
            <For each={group().messages} keyed={(item) => item.key}>
              {(item, index) => (
                <PreparedMessage
                  group={group()}
                  item={item()}
                  index={index()}
                  options={{ ...props.options, toolCardOverrides: overrides() }}
                />
              )}
            </For>
          )}
        </For>
      )}
    />
  );
}

export function MessageGroupContent(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const options = createMemo(() => resolveFileLinkOwnerOptions(props.group, props.options));
  return (
    <Show
      when={!isActivityMessageGroup(props.group, options().bubbleMode)}
      fallback={
        <ActivityGroup groups={[props.group]} options={options()} presentation="continuation" />
      }
    >
      <For each={props.group.messages} keyed={(item) => item.key}>
        {(item, index) => (
          <PreparedMessage
            group={props.group}
            item={item()}
            index={index()}
            options={{ ...options(), isForwarded: hasForwardedSource(props.group) }}
          />
        )}
      </For>
      {options().showToolCalls === false ? undefined : (
        <LitContent value={renderBrowserTabPreviews([props.group], options())} />
      )}
    </Show>
  );
}

function GroupAvatar(props: { frame: MessageGroupFrame }) {
  const frame = () => props.frame;
  const options = () => frame().options;
  return (
    <Show when={frame().hasAvatar}>
      <LitContent
        value={
          frame().isForwarded
            ? renderForwardedAvatar(frame().group.senderSession?.agentId, options())
            : renderChatAvatar(
                frame().group.role,
                {
                  agentId: options().agentId,
                  name: frame().assistantName,
                  avatar: options().assistantAvatar ?? null,
                  textAvatar: options().assistantTextAvatar,
                },
                frame().isOwnGroup
                  ? {
                      name: options().userName ?? null,
                      avatar: options().userAvatar ?? null,
                    }
                  : undefined,
                frame().group.sender,
              )
        }
      />
    </Show>
  );
}

function SenderIdentity(props: { frame: MessageGroupFrame }) {
  const frame = () => props.frame;
  const activityLink = createMemo(() => {
    const current = frame();
    const identity = current.group.sender?.identity;
    return current.isPeerGroup && identity?.type === "profile"
      ? personActivityLink(identity.id, current.options.personActivity, current.who)
      : null;
  });
  return (
    <>
      <Show when={frame().showSenderName}>
        <LitContent value={renderPersonName(frame().who, activityLink(), "chat-sender-name")} />
      </Show>
      <Show when={frame().visibleSources?.length}>
        <span class="chat-message-source">
          {messageClientSourcesLabel(frame().visibleSources!)}
        </span>
      </Show>
    </>
  );
}

function UserFooterActions(props: { frame: MessageGroupFrame }) {
  const frame = () => props.frame;
  const options = () => frame().options;
  return (
    <Show when={frame().hasUserFooterActions}>
      <div
        class="chat-group-footer-actions"
        data-message-actions-for={frame().footerActionMessageKey}
      >
        <Show when={Boolean(frame().footerActionDetails?.replyTarget && options().onReply)}>
          <ReplyButton
            target={frame().footerActionDetails!.replyTarget!}
            onReply={options().onReply!}
          />
        </Show>
        <Show when={options().onRewind && !options().rewindDisabled}>
          <RewindButton onRewind={options().onRewind!} />
        </Show>
        <MessageActions
          details={frame().footerActionDetails}
          options={messageReactionOptions(frame().group, options())}
        />
      </div>
    </Show>
  );
}

function FramedMessage(props: {
  frame: MessageGroupFrame;
  item: GroupMessage;
  index: number;
  mobile: boolean;
}) {
  const frame = () => props.frame;
  const prepared = () => frame().preparedMessages[props.index]!;
  const line = createMemo(() =>
    frame().normalizedRole === "assistant"
      ? NO_REPLY_LINE
      : resolveMessageReplyLine(
          prepared().source.normalizedMessage,
          frame().options.resolveReplyPreview,
          frame().options.userId,
          frame().isPeerGroup || frame().group.replyShared,
        ),
  );
  const peerHoldsRow = () => frame().isPeerGroup && line().state !== "hidden";
  const avatar = () => <GroupAvatar frame={props.frame} />;
  const options = createMemo(() => ({
    ...frame().options,
    isForwarded: frame().forwardedSource,
    replyLine: frame().isPeerGroup ? undefined : line(),
    avatar:
      !peerHoldsRow() &&
      frame().inlineUserAvatar &&
      (frame().isPeerGroup || props.index === frame().lastMessageIndex) &&
      frame().hasAvatar
        ? avatar
        : undefined,
  }));
  const showActions = () =>
    hasMessageActionButtons(prepared().actions, frame().options) &&
    props.index < frame().lastMessageIndex &&
    !frame().isTurnBlock;
  return (
    <>
      {/* Showing a previously absent peer reply changes this local message's structural wrapper. */}
      <Show
        when={peerHoldsRow()}
        fallback={
          <>
            {frame().isPeerGroup ? (
              <LitContent value={renderReplyLine(line(), frame().options)} />
            ) : undefined}
            <PreparedMessage
              group={frame().group}
              item={props.item}
              index={props.index}
              options={options()}
              prepared={prepared()}
            />
          </>
        }
      >
        <div class="chat-message--reply">
          <LitContent value={renderReplyLine(line(), frame().options)} />
          <PreparedMessage
            group={frame().group}
            item={props.item}
            index={props.index}
            options={options()}
            prepared={prepared()}
          />
          <GroupAvatar frame={props.frame} />
          <LitContent
            value={renderReplyLineConnector(line(), frame().hasAvatar ? true : litNothing)}
          />
        </div>
      </Show>
      <Show when={showActions()}>
        <Show
          when={props.mobile}
          fallback={
            <MessageActionsRow
              messageKey={props.item.key}
              details={prepared().actions}
              options={frame().options}
              class="chat-message-actions-row"
            />
          }
        >
          <div class="chat-group-footer chat-message-footer">
            <div class="chat-group-footer__meta">
              <SenderIdentity frame={props.frame} />
              <MessageMeta timestamp={prepared().source.normalizedMessage.timestamp} meta={null} />
            </div>
            <MessageActionsRow
              messageKey={props.item.key}
              details={prepared().actions}
              options={frame().options}
            />
          </div>
        </Show>
      </Show>
    </>
  );
}

function FramedMessageGroup(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const frame = createMemo(() => prepareMessageGroupFrame(props.group, props.options));
  const options = () => frame().options;
  const media = globalThis.matchMedia?.(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  );
  const [mobile, setMobile] = createSignal(media?.matches ?? false);
  const onLayoutChange = () => setMobile(media?.matches ?? false);
  media?.addEventListener("change", onLayoutChange);
  onCleanup(() => media?.removeEventListener("change", onLayoutChange));
  return (
    <div
      class={frame().className}
      style={frame().style}
      data-chat-row-key={props.group.key}
      data-file-session-key={frame().sessionKey}
    >
      <Show when={!frame().inlineUserAvatar}>
        <GroupAvatar frame={frame()} />
      </Show>
      <div class="chat-group-messages">
        <Show when={frame().forwardedSource}>
          <LitContent value={renderForwardedAttribution(props.group, options())} />
        </Show>
        <LitContent value={renderReplyLine(frame().replyLine, options())} />
        <Show
          when={options().frameContent !== undefined}
          fallback={
            <For each={props.group.messages} keyed={(item) => item.key}>
              {(item, index) => (
                <FramedMessage frame={frame()} item={item()} index={index()} mobile={mobile()} />
              )}
            </For>
          }
        >
          {options().frameContent}
        </Show>
        {frame().ownsRunFrame || options().showToolCalls === false ? undefined : (
          <LitContent value={renderBrowserTabPreviews([props.group], options())} />
        )}
        <Show
          when={Boolean(options().activeContinuation)}
          fallback={
            options().turnRecap ? (
              <LitContent
                value={renderTurnRecapRow(options().turnRecap!, { presentation: "continuation" })}
              />
            ) : undefined
          }
        >
          <StreamGroupParts
            parts={options().activeContinuation!.parts}
            options={options().activeContinuation!.options}
            presentation="continuation"
          />
        </Show>
      </div>
      <Show when={!frame().isTurnBlock}>
        <Show
          when={!props.group.isStreaming && !options().activeContinuation}
          fallback={renderSolidEmptyGroupFooter()}
        >
          <div
            class={[
              "chat-group-footer",
              {
                "chat-group-footer--persistent-identity":
                  frame().normalizedRole === "user" &&
                  Boolean(
                    frame().visibleSources?.length ||
                    frame().isPeerGroup ||
                    (frame().showSenderName && frame().avatarPlacement !== "footer"),
                  ),
                "chat-group-footer--send-status": Boolean(frame().sendStatus),
              },
            ]}
          >
            <Show when={!frame().isPeerGroup}>
              <UserFooterActions frame={frame()} />
            </Show>
            <div class="chat-group-footer__meta">
              {frame().normalizedRole === "user" &&
              frame().showAvatar &&
              frame().avatarPlacement === "footer" ? (
                <LitContent value={renderChatAuthorAvatar(props.group.sender)} />
              ) : undefined}
              <SenderIdentity frame={frame()} />
              <ChatSendStatus status={frame().sendStatus} actions={options()} />
              <MessageMeta timestamp={props.group.timestamp} meta={frame().meta} />
            </div>
            <Show
              when={frame().isPeerGroup}
              fallback={
                <Show when={frame().normalizedRole !== "user" && frame().footerActionDetails}>
                  <MessageActionsRow
                    messageKey={frame().footerActionMessageKey}
                    details={frame().footerActionDetails}
                    options={options()}
                  />
                </Show>
              }
            >
              <UserFooterActions frame={frame()} />
            </Show>
          </div>
        </Show>
      </Show>
      <LitContent
        value={renderReplyLineConnector(frame().replyLine, frame().hasAvatar ? true : litNothing)}
      />
    </div>
  );
}

function SessionActivityGroup(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const options = createMemo(() => resolveFileLinkOwnerOptions(props.group, props.options));
  return (
    <ChatSessionActivity
      group={props.group}
      options={options()}
      renderEntry={(item, index) => {
        const prepared = createMemo(() => prepareGroupMessage(props.group, item(), options()));
        return {
          content: (
            <PreparedMessage
              group={props.group}
              item={item()}
              index={index()}
              prepared={prepared()}
              options={{
                ...options(),
                isForwarded: true,
                onToggleUserMessageExpanded: undefined,
                replyLine: resolveGroupReplyLine(
                  { ...props.group, messages: [item()] },
                  options().resolveReplyPreview,
                ),
              }}
            />
          ),
          actions: <MessageActions details={prepared().actions} options={options()} />,
        };
      }}
    />
  );
}

export function renderSolidMessageGroup(
  group: MessageGroupData,
  options: NativeMessageGroupOptions,
) {
  return <MessageGroup group={group} options={options} />;
}

export function MessageGroup(props: {
  group: MessageGroupData;
  options: NativeMessageGroupOptions;
}) {
  const options = createMemo(() => resolveFileLinkOwnerOptions(props.group, props.options));
  return (
    <Show
      when={!isSessionActivityGroup(props.group)}
      fallback={<SessionActivityGroup group={props.group} options={props.options} />}
    >
      <Show
        when={
          normalizeRoleForGrouping(props.group.role) !== "tool" || options().showToolCalls !== false
        }
      >
        <Show
          when={!isActivityMessageGroup(props.group, options().bubbleMode)}
          fallback={
            <ActivityGroup groups={[props.group]} options={options()} presentation="standalone" />
          }
        >
          <FramedMessageGroup group={props.group} options={props.options} />
        </Show>
      </Show>
    </Show>
  );
}
