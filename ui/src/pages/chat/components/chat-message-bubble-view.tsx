import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  For,
  Match,
  Show,
  Switch,
  onCleanup,
  type Accessor,
  untrack,
} from "solid-js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { presentedContent } from "../../../lit/presentation-binding.ts";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { assistantMessageIsInterrupted } from "../chat-assistant-reply.ts";
import { renderAsyncQuestionSummary } from "./chat-async-question.ts";
import "../../../components/person-reference.ts";
import { ChatBubbleActivity } from "./chat-bubble-activity-view.tsx";
import { OmittedMedia } from "./chat-message-attachment-status-solid.tsx";
import { AssistantAttachments, MessageAttachment } from "./chat-message-attachments-solid.tsx";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import {
  prepareGroupedMessage,
  type GroupedMessagePresentation,
} from "./chat-message-bubble-presentation.ts";
import { MessageWorkContext } from "./chat-message-context-view.tsx";
import { MessageImages } from "./chat-message-images-solid.tsx";
import { renderMessageImages } from "./chat-message-images.ts";
import "./chat-clawhub-card.ts";
import type { ChatMessageRenderPreparation } from "./chat-message-markdown-view.tsx";
import type { MarkdownMedia } from "./chat-message-media-markdown.ts";
import { prepareMarkdownMedia } from "./chat-message-media-markdown.ts";
import { type AttachmentItem, schedulePairingQrExpiryRefresh } from "./chat-message-media.ts";
import { MarkdownText, MessageJson, MessageMarkdown } from "./chat-message-text-view.tsx";
import { renderReplyLine } from "./chat-reply-attribution.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import {
  renderPluginToolResult,
  renderToolApprovalReviews,
  renderToolCard,
  renderToolIcon,
  syncToolDisclosureOverflow,
} from "./chat-tool-cards.ts";
import {
  renderExpandedToolCardContent,
  renderRawOutputToggle,
  renderToolOutcome,
} from "./chat-tool-content.ts";
import { renderWorkspaceConflictTranscriptMessage } from "./chat-workspace-conflict.ts";
import { renderToolPreview } from "./widget-card.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

export type GroupedMessageProps = {
  preparation: ChatMessageRenderPreparation;
  messageKey: string;
  options: GroupedMessageOptions;
  onOpenSidebar?: (content: SidebarContent) => void;
};

type ContentProps = {
  state: Accessor<GroupedMessagePresentation>;
  messageKey: string;
  options: GroupedMessageOptions;
  onOpenSidebar?: (content: SidebarContent) => void;
};

export function renderSolidGroupedMessage(
  preparation: ChatMessageRenderPreparation,
  messageKey: string,
  options: GroupedMessageOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  return (
    <GroupedMessage
      preparation={preparation}
      messageKey={messageKey}
      options={options}
      onOpenSidebar={onOpenSidebar}
    />
  );
}

/** Message identity owns text/media DOM; option refreshes only publish new facts. */
export function GroupedMessage(props: GroupedMessageProps) {
  const state = createMemo(() =>
    prepareGroupedMessage(props.preparation, props.messageKey, props.options, props.onOpenSidebar),
  );
  let element: Element | undefined;
  // Bind arrivals before the transcript commit consumes their pending identities.
  let currentEntryRef = untrack(() => props.options.entryRef);
  createEffect(
    () => props.options.entryRef,
    (next) => {
      if (currentEntryRef !== next) {
        currentEntryRef?.(undefined);
      }
      currentEntryRef = next;
      if (element) {
        currentEntryRef?.(element);
      }
    },
  );
  createEffect(
    () =>
      [props.messageKey, state().nextPairingQrExpiresAt, props.options.onRequestUpdate] as const,
    ([key, expiresAt, requestUpdate]) =>
      schedulePairingQrExpiryRefresh(key, expiresAt, requestUpdate),
  );
  onCleanup(() => currentEntryRef?.(undefined));
  const entryRef = (next: Element) => {
    element = next;
    currentEntryRef?.(next);
  };
  return (
    <Show
      when={state().workspaceConflict}
      fallback={
        <Show when={!state().empty}>
          <div
            class={state().bubbleClasses}
            ref={entryRef}
            data-message-id={props.messageKey}
            data-file-session-key={props.options.fileLinkSessionKey}
            data-entry-id={props.options.entryId || undefined}
            data-message-text={state().actionText || undefined}
            prop:messageActions={props.options.messageActions}
          >
            <Show when={props.options.replyLine}>
              <LitContent value={renderReplyLine(props.options.replyLine!, props.options, true)} />
            </Show>
            <Switch>
              <Match when={state().onlyToolCards}>
                <InlineToolCards cards={state().toolCards} options={state().toolRenderOptions} />
              </Match>
              <Match when={state().isStandaloneToolMessage}>
                <ToolMessage
                  state={state}
                  messageKey={props.messageKey}
                  options={props.options}
                  onOpenSidebar={props.onOpenSidebar}
                />
              </Match>
              <Match when={true}>
                <BubbleContents
                  state={state}
                  messageKey={props.messageKey}
                  options={props.options}
                  onOpenSidebar={props.onOpenSidebar}
                />
              </Match>
            </Switch>
            <Show
              when={
                state().sourceRole === "assistant" && assistantMessageIsInterrupted(state().message)
              }
            >
              <div
                class="chat-tasks-status chat-turn-recap chat-turn-recap--continuation"
                role="status"
              >
                {t("chat.composer.runInterrupted")}
              </div>
            </Show>
            <Show when={state().duplicateCount > 1 && (!state().markdown || state().jsonResult)}>
              <div
                class="chat-duplicate-count"
                aria-label={t("chat.messages.duplicatesCollapsed", {
                  count: String(state().duplicateCount),
                })}
              >
                ×{state().duplicateCount}
              </div>
            </Show>
          </div>
          <MessageWorkContext message={state().message} />
        </Show>
      }
    >
      <LitContent
        value={renderWorkspaceConflictTranscriptMessage(
          state().workspaceConflict!,
          props.messageKey,
          props.options.entryId,
        )}
      />
    </Show>
  );
}

function InlineToolCards(props: {
  cards: ToolCard[];
  options: Omit<Parameters<typeof renderToolCard>[1], "expanded" | "onToggleExpanded"> & {
    isToolExpanded?: (id: string) => boolean;
    onToggleToolExpanded?: (id: string, expanded?: boolean) => void;
    toolCardOverrides?: ReadonlyMap<ToolCard, unknown>;
  };
}) {
  return (
    <div class="chat-tools-inline">
      <For each={props.cards} keyed={(card) => card.callId ?? card}>
        {(card, index) => {
          const disclosureId = () => `${props.options.messageKey}:toolcard:${index()}`;
          const expanded = () => props.options.isToolExpanded?.(disclosureId()) ?? false;
          return (
            <LitContent
              value={
                props.options.toolCardOverrides?.has(card())
                  ? props.options.toolCardOverrides.get(card())
                  : renderToolCard(card(), {
                      ...props.options,
                      expanded: expanded(),
                      onToggleExpanded: () =>
                        props.options.onToggleToolExpanded?.(disclosureId(), expanded()),
                    })
              }
            />
          );
        }}
      </For>
    </div>
  );
}

function PairingQrNotices(props: { count: number }) {
  const count = createMemo(() => props.count);
  return (
    <Show when={count() > 0}>
      <div class="chat-pairing-qr-notices">
        <For each={Array.from({ length: count() }, (_, index) => index)}>
          {() => (
            <div class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked chat-pairing-qr-expired">
              <span class="chat-pairing-qr-expired__icon" aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <div class="chat-pairing-qr-expired__content">
                <div class="chat-pairing-qr-expired__heading">
                  <span class="chat-pairing-qr-expired__title">
                    {t("chat.pairingQrExpired.title")}
                  </span>
                  <span class="chat-pairing-qr-expired__badge">
                    {t("chat.pairingQrExpired.badge")}
                  </span>
                </div>
                <div class="chat-assistant-attachment-card__reason">
                  {t("chat.pairingQrExpired.reason")}
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function AssistantViews(props: ContentProps) {
  const messageTimestamp = () => {
    const value = props.state().m.timestamp;
    return typeof value === "number" ? value : undefined;
  };
  return (
    <Show when={props.state().sourceRole === "assistant"}>
      <For each={props.state().assistantViewBlocks} keyed={false}>
        {(block) => (
          <div class="chat-tool-card__widget-host">
            <LitContent
              value={renderToolPreview(block().preview, "chat_message", {
                rawText: block().rawText ?? null,
                canvasPluginSurfaceUrl: props.options.canvasPluginSurfaceUrl,
                boardProvider: props.options.boardProvider,
                embedSandboxMode: props.options.embedSandboxMode ?? "scripts",
                allowExternalEmbedUrls: props.options.allowExternalEmbedUrls,
                sessionKey: props.options.sessionKey,
                messageTimestamp: messageTimestamp(),
              })}
            />
            <Show when={block().rawText}>
              <div class="chat-tool-card__widget-raw">
                <LitContent value={renderRawOutputToggle(block().rawText!)} />
              </div>
            </Show>
          </div>
        )}
      </For>
    </Show>
  );
}

function MessageText(props: ContentProps) {
  const prepared = createMemo(() => {
    const state = props.state();
    const options = {
      ...props.options,
      role: state.isStandaloneToolMessage && !state.renderInOrder ? "tool" : state.normalizedRole,
    };
    let text = state.bodyMarkdown;
    let media: MarkdownMedia | undefined;
    if (!state.asyncQuestions && state.renderInOrder) {
      const ordered = prepareMarkdownMedia(state.orderedContent, (item) =>
        item.type === "image"
          ? renderMessageImages([item.image], state.imageRenderOptions)
          : renderAssistantAttachments(
              [item],
              state.imageRenderOptions,
              props.onOpenSidebar,
              props.options.onAssistantAttachmentLoaded,
            ),
      );
      text = resolveMessageDisplayMarkdown(state.message, {
        ...state.normalizedMessage,
        content: [{ type: "text", text: ordered.markdown }],
      });
      options.assistantMessageDisclosure = state.disclosure
        ? { ...state.disclosure, markdown: text }
        : undefined;
      media = { ...ordered.media, text: state.bodyMarkdown ?? "" };
    }
    return { text, options, media, json: state.renderInOrder ? null : state.jsonResult };
  });
  return (
    <Switch>
      <Match when={props.state().asyncQuestions}>
        <LitContent
          value={renderAsyncQuestionSummary(
            props.state().asyncQuestions!,
            props.options.asyncQuestions!,
          )}
        />
      </Match>
      <Match when={prepared().json}>
        <MessageJson
          json={prepared().json!}
          messageKey={props.messageKey}
          options={prepared().options}
          markdownOptions={props.state().markdownRenderOptions}
        />
      </Match>
      <Match when={prepared().text}>
        <MessageMarkdown
          markdown={prepared().text ?? ""}
          messageKey={props.messageKey}
          options={prepared().options}
          markdownOptions={props.state().markdownRenderOptions}
          duplicateSuffix={props.state().duplicateSuffix}
          media={prepared().media}
        />
      </Match>
    </Switch>
  );
}

function MessageAvatar(props: { render?: () => JSX.Element }) {
  const render = createMemo(() => props.render);
  const avatar = createMemo(() => {
    const factory = render();
    return factory ? untrack(factory) : undefined;
  });
  return <>{avatar()}</>;
}

function VideoPreview(props: ContentProps & { item: Accessor<AttachmentItem | undefined> }) {
  return (
    <div class="chat-image-frame chat-video-preview">
      <Show when={props.item()}>
        {(item) => (
          <LitContent
            value={presentedContent(
              props.options.transcriptVisible ?? true,
              solidContent(MessageAttachment, {
                item: item(),
                options: props.state().imageRenderOptions,
                onOpenSidebar: props.onOpenSidebar,
                onAssistantAttachmentLoaded: props.options.onAssistantAttachmentLoaded,
                presentation: "preview",
              }),
            )}
          />
        )}
      </Show>
    </div>
  );
}

function MessageReasoning(props: Pick<ContentProps, "state" | "options">) {
  const content = (
    <MarkdownText
      class="chat-thinking"
      content={toSanitizedMarkdownHtml(props.state().reasoningMarkdown ?? "", {
        codeBlockInteraction: "interactive",
      })}
    />
  );
  return (
    <Show when={props.options.bubbleMode} fallback={content}>
      <ChatBubbleActivity label={t("chat.view.reasoning")}>{content}</ChatBubbleActivity>
    </Show>
  );
}

function BubbleContents(props: ContentProps) {
  const previewCount = createMemo(() => props.state().videoPreviews.length);
  const previews = createMemo(() =>
    Array.from({ length: previewCount() }, (_, index) => (
      <VideoPreview
        state={props.state}
        messageKey={props.messageKey}
        options={props.options}
        onOpenSidebar={props.onOpenSidebar}
        item={() => props.state().videoPreviews[index]}
      />
    )),
  );
  const hasText = () =>
    Boolean(props.state().bodyMarkdown || props.state().asyncQuestions || props.state().jsonResult);
  return (
    <>
      <Show when={props.state().sourceRole === "assistant"}>
        <For each={props.state().clawHubCards} keyed={(card) => card.id}>
          {(card) => (
            <openclaw-chat-clawhub-card
              prop:recommendation={card()}
              prop:agentId={props.options.agentId}
            />
          )}
        </For>
      </Show>
      <PairingQrNotices count={props.state().expiredPairingQrCount} />
      <MessageImages
        images={
          props.state().renderInOrder ? props.state().supplementalImages : props.state().images
        }
        options={props.state().imageRenderOptions}
        previews={previews()}
      />
      <OmittedMedia items={props.state().omittedMedia} />
      <AssistantAttachments
        attachments={
          props.state().renderInOrder
            ? props.state().supplementalAttachments
            : props.state().cardAttachments
        }
        options={props.state().imageRenderOptions}
        onOpenSidebar={props.onOpenSidebar}
        onAssistantAttachmentLoaded={props.options.onAssistantAttachmentLoaded}
        inlinePlayback={props.state().normalizedRole === "assistant"}
      />
      <Show when={props.state().isStandaloneToolMessage}>
        <AssistantViews {...props} />
      </Show>
      <Show when={props.state().reasoningMarkdown}>
        <MessageReasoning state={props.state} options={props.options} />
      </Show>
      <Show when={!props.state().isStandaloneToolMessage}>
        <AssistantViews {...props} />
      </Show>
      <Show when={props.state().normalizedRole === "user"} fallback={<MessageText {...props} />}>
        <Show when={hasText() || props.options.avatar}>
          <div class="chat-message-avatar-anchor">
            <MessageText {...props} />
            <MessageAvatar render={props.options.avatar} />
          </div>
        </Show>
      </Show>
      <Show when={props.state().hasToolCards}>
        <Show
          when={
            props.state().isStandaloneToolMessage &&
            props.state().expandsSingleToolCard &&
            props.state().singleToolCard
          }
          fallback={
            <InlineToolCards
              cards={props.state().toolCards}
              options={{
                ...props.state().toolRenderOptions,
                showApprovalReviews: props.state().isStandaloneToolMessage ? false : undefined,
              }}
            />
          }
        >
          <LitContent
            value={renderExpandedToolCardContent(
              props.state().singleToolCard!,
              props.state().toolRenderOptions,
            )}
          />
        </Show>
      </Show>
      <Show when={props.state().isStandaloneToolMessage && props.state().failedToolCard}>
        <LitContent value={renderToolOutcome("failed", props.state().failedToolCard!.exitCode)} />
      </Show>
    </>
  );
}

function ToolMessageFallback(props: ContentProps) {
  return (
    <div
      class={[
        "chat-tool-msg-collapse chat-tool-msg-collapse--manual",
        { "is-open": props.state().toolMessageExpanded },
      ]}
    >
      <button
        class="chat-inline-disclosure chat-tool-msg-summary"
        type="button"
        aria-expanded={props.state().toolMessageExpanded ? "true" : "false"}
        onPointerEnter={syncToolDisclosureOverflow}
        onFocus={syncToolDisclosureOverflow}
        onClick={() =>
          props.options.onToggleToolMessageExpanded?.(
            props.state().toolMessageDisclosureId,
            props.state().toolMessageExpanded,
          )
        }
      >
        <span class="chat-tool-msg-summary__icon">
          <Show when={props.state().singleToolDisplay} fallback={<Icon name="zap" />}>
            <LitContent
              value={renderToolIcon(props.state().singleToolDisplay!.icon, {
                toolName: props.state().singleToolDisplay!.name,
                pluginToolIcons: props.options.pluginToolIcons,
              })}
            />
          </Show>
        </span>
        <span class="chat-tool-disclosure__content">
          <span class="chat-tool-msg-summary__label">{props.state().toolMessageLabel}</span>
          <Show
            when={props.state().toolSummaryLabel}
            fallback={
              <Show when={props.state().toolPreview}>
                <span class="chat-tool-msg-summary__preview">{props.state().toolPreview}</span>
              </Show>
            }
          >
            <span class="chat-tool-msg-summary__names">{props.state().toolSummaryLabel}</span>
          </Show>
        </span>
        <span class="chat-tool-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </button>
      <Show
        when={props.state().toolMessageExpanded}
        fallback={<OmittedMedia items={props.state().omittedMedia} />}
      >
        <div class="chat-tool-msg-body">
          <BubbleContents {...props} />
        </div>
      </Show>
      <For each={props.state().toolCards} keyed={(card) => card.callId ?? card}>
        {(card) => <LitContent value={renderToolApprovalReviews(card())} />}
      </For>
    </div>
  );
}

function ToolMessage(props: ContentProps) {
  const fallback = solidContent(ToolMessageFallback, {
    get state() {
      return props.state;
    },
    get messageKey() {
      return props.messageKey;
    },
    get options() {
      return props.options;
    },
    get onOpenSidebar() {
      return props.onOpenSidebar;
    },
  });
  return (
    <LitContent
      value={renderPluginToolResult(
        props.state().singleToolCard,
        {
          ...props.state().toolRenderOptions,
          expanded: props.state().toolMessageExpanded,
        },
        fallback,
      )}
    />
  );
}
