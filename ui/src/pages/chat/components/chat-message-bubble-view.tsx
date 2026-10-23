import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  lazy,
  For,
  Match,
  Repeat,
  Show,
  Switch,
  onCleanup,
  type Accessor,
  refresh,
  untrack,
  useContext,
} from "solid-js";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import { unwrapToolCallForDisplay } from "../../../../../src/agents/tool-display-call.js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { PluginSurface } from "../../../plugins/control-ui-view.solid.tsx";
import { assistantMessageIsInterrupted } from "../chat-assistant-reply.ts";
import "../../../components/solid/person-reference.tsx";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { AsyncQuestionSummary } from "./chat-async-question-summary.tsx";
import { ChatBubbleActivity } from "./chat-bubble-activity-view.tsx";
import { ChatImportBoundary } from "./chat-import-boundary.tsx";
import { ActivityOperation } from "./chat-message-activity-operation.tsx";
import { OmittedMedia } from "./chat-message-attachment-status-solid.tsx";
import type {
  ActivityOperationProps,
  GroupedMessageOptions,
} from "./chat-message-bubble-options.ts";
import {
  prepareGroupedMessage,
  type GroupedMessagePresentation,
} from "./chat-message-bubble-presentation.ts";
import { MessageWorkContext } from "./chat-message-context-view.tsx";
import {
  AssistantAttachments,
  ChatClawHubCard,
  MessageAttachment,
  MessageImages,
} from "./chat-message-deferred.tsx";
import type { ChatMessageRenderPreparation } from "./chat-message-markdown-view.tsx";
import type { MarkdownMedia, PositionedMedia } from "./chat-message-media-markdown.ts";
import { prepareMarkdownMedia } from "./chat-message-media-markdown.ts";
import {
  type AttachmentItem,
  schedulePairingQrExpiryRefresh,
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceOwner,
} from "./chat-message-media.ts";
import { MarkdownText, MessageJson, MessageMarkdown } from "./chat-message-text-view.tsx";
import { ChatPermissionCard } from "./chat-permission-card.tsx";
import { ReplyLineView } from "./chat-reply-attribution.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { ChatToolIcon } from "./chat-tool-card-chrome.tsx";
import type { ToolCardOptions } from "./chat-tool-card-types.ts";
import { ToolApprovalReviews, ChatToolCard } from "./chat-tool-cards.solid.tsx";
import {
  ExpandedToolCardContent,
  RawOutputToggle,
  ToolOutcome,
} from "./chat-tool-content.solid.tsx";
import { toolResultSurfaceProps } from "./chat-tool-render-model.ts";
import { TranscriptMessageElementsContext } from "./chat-transcript-message-elements.ts";
import { WorkspaceConflictTranscriptMessage } from "./chat-workspace-conflict.ts";
import { ToolPreview } from "./widget-card.ts";

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerChatMessageMetadataEnglish);

const ToolMessageSummary = lazy(() => import("./chat-tool-card-row.solid.tsx"), {
  export: "ToolMessageSummary",
});

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

/** Message identity owns text/media DOM; option refreshes only publish new facts. */
export function GroupedMessage(props: GroupedMessageProps) {
  const refreshMedia = () => void refresh(state);
  const state = createMemo(() => {
    observeChatMediaResourceSubscriber(props.options.mediaOwner, refreshMedia);
    return prepareGroupedMessage(
      props.preparation,
      props.messageKey,
      props.options,
      props.onOpenSidebar,
    );
  });
  const messageElements = useContext(TranscriptMessageElementsContext);
  // The keyed message owns this DOM registration through acknowledgement and option refreshes.
  const initialMessageKey = untrack(() => props.messageKey);
  // Expiring pairing QR attachments schedule a timer at their resource owner.
  createEffect(
    () => [props.messageKey, state().nextPairingQrExpiresAt] as const,
    ([key, expiresAt]) => schedulePairingQrExpiryRefresh(key, expiresAt, refreshMedia),
  );
  onCleanup(() => releaseChatMediaResourceOwner(refreshMedia));
  return (
    <Show
      when={state().workspaceConflict}
      fallback={
        <Show when={!state().empty}>
          {(_visible) => {
            const entryRef = messageElements?.forKey(initialMessageKey);
            const bindEntry = elementRef((element) => {
              entryRef?.(element);
              return () => entryRef?.(undefined);
            });
            return (
              <>
                <div
                  class={state().bubbleClasses}
                  ref={[bindEntry]}
                  data-message-id={props.messageKey}
                  data-file-session-key={props.options.fileLinkSessionKey}
                  data-entry-id={props.options.entryId || undefined}
                  data-message-text={state().actionText || undefined}
                  prop:messageActions={props.options.messageActions}
                >
                  <Show when={props.options.replyLine}>
                    <ReplyLineView line={props.options.replyLine!} actions={props.options} inline />
                  </Show>
                  <Switch>
                    <Match when={state().voiceTranscript}>
                      <ChatBubbleActivity
                        label={t("chat.messages.voiceTranscript")}
                        open={props.options.searchResult}
                      >
                        <BubbleContents
                          state={state}
                          messageKey={props.messageKey}
                          options={props.options}
                          onOpenSidebar={props.onOpenSidebar}
                        />
                      </ChatBubbleActivity>
                    </Match>
                    <Match when={state().onlyToolCards}>
                      <InlineToolCards
                        cards={state().toolCards}
                        options={state().toolRenderOptions}
                      />
                    </Match>
                    <Match when={state().isStandaloneToolMessage}>
                      <ToolMessage {...props} state={state} />
                    </Match>
                    <Match when={true}>
                      {/* Keep preparation out of this boundary so refreshes retain embedded media. */}
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
                      state().sourceRole === "assistant" &&
                      assistantMessageIsInterrupted(state().message)
                    }
                  >
                    <div
                      class="chat-tasks-status chat-turn-recap chat-turn-recap--continuation"
                      role="status"
                    >
                      {t("chat.composer.runInterrupted")}
                    </div>
                  </Show>
                  <Show
                    when={state().duplicateCount > 1 && (!state().markdown || state().jsonResult)}
                  >
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
              </>
            );
          }}
        </Show>
      }
    >
      {(conflict) => {
        const entryRef = messageElements?.forKey(initialMessageKey);
        const bindEntry = elementRef((element) => {
          entryRef?.(element);
          return () => entryRef?.(undefined);
        });
        return (
          <WorkspaceConflictTranscriptMessage
            conflict={conflict()}
            messageKey={props.messageKey}
            entryId={props.options.entryId}
            ref={bindEntry}
          />
        );
      }}
    </Show>
  );
}

function InlineToolCards(props: {
  cards: ToolCard[];
  options: Omit<ToolCardOptions, "expanded" | "onToggleExpanded"> & {
    isToolExpanded?: (id: string) => boolean;
    onToggleToolExpanded?: (id: string, expanded?: boolean) => void;
    toolCardOverrides?: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
  };
}) {
  return (
    <div class="chat-tools-inline">
      <For each={props.cards} keyed={(card) => card.callId ?? card}>
        {(card, index) => {
          const disclosureId = () => `${props.options.messageKey}:toolcard:${index()}`;
          const expanded = () => props.options.isToolExpanded?.(disclosureId()) ?? false;
          return (
            <Show
              when={props.options.toolCardOverrides?.has(card())}
              fallback={
                <ChatToolCard
                  card={card()}
                  options={{
                    ...props.options,
                    expanded: expanded(),
                    onToggleExpanded: () =>
                      props.options.onToggleToolExpanded?.(disclosureId(), expanded()),
                  }}
                />
              }
            >
              <Show when={props.options.toolCardOverrides?.get(card())}>
                {(operation) => <ActivityOperation {...operation()} />}
              </Show>
            </Show>
          );
        }}
      </For>
    </div>
  );
}

function PairingQrNotices(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <div class="chat-pairing-qr-notices">
        <Repeat count={props.count}>
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
        </Repeat>
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
        {(block) => {
          let rawToggle: HTMLButtonElement | undefined;
          return (
            <div class="chat-tool-card__widget-host">
              <ToolPreview
                preview={block().preview}
                surface="chat_message"
                options={{
                  rawText: block().rawText ?? null,
                  toggleRawDetails: () => {
                    const open = rawToggle?.getAttribute("aria-expanded") !== "true";
                    rawToggle?.click();
                    return Boolean(rawToggle && open);
                  },
                  canvasPluginSurfaceUrl: props.options.canvasPluginSurfaceUrl,
                  boardProvider: props.options.boardProvider,
                  widgetLayout: props.options.widgetLayout,
                  embedSandboxMode: props.options.embedSandboxMode ?? "scripts",
                  allowExternalEmbedUrls: props.options.allowExternalEmbedUrls,
                  sessionKey: props.options.sessionKey,
                  messageTimestamp: messageTimestamp(),
                }}
              />
              <Show when={block().rawText}>
                <div class="chat-tool-card__widget-raw">
                  <openclaw-chat-tool-raw style={{ display: "contents" }}>
                    <RawOutputToggle
                      text={block().rawText!}
                      toggleRef={(element) => (rawToggle = element)}
                    />
                  </openclaw-chat-tool-raw>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </Show>
  );
}

function MessageText(props: ContentProps) {
  const OrderedMedia = (media: { item: PositionedMedia }) => (
    <Show
      when={media.item.type === "image" ? media.item.image : undefined}
      fallback={
        <AssistantAttachments
          attachments={media.item.type === "image" ? [] : [media.item]}
          options={props.state().imageRenderOptions}
          onOpenSidebar={props.onOpenSidebar}
          onAssistantAttachmentLoaded={props.options.onAssistantAttachmentLoaded}
        />
      }
    >
      {(image) => <MessageImages images={[image()]} options={props.state().imageRenderOptions} />}
    </Show>
  );
  const prepared = createMemo(() => {
    const state = props.state();
    const options = {
      ...props.options,
      role: state.isStandaloneToolMessage && !state.renderInOrder ? "tool" : state.normalizedRole,
    };
    let text = state.bodyMarkdown;
    let media: MarkdownMedia | undefined;
    if (!state.asyncQuestions && state.renderInOrder) {
      const ordered = prepareMarkdownMedia(state.orderedContent, OrderedMedia);
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
        <AsyncQuestionSummary
          questions={props.state().asyncQuestions!}
          presentation={props.options.asyncQuestions!}
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
  // Replacing the factory retires its bindings; updates inside it stay with its owner.
  return (
    <Show when={props.render} keyed>
      {(render) => render()}
    </Show>
  );
}

function VideoPreview(props: ContentProps & { item: Accessor<AttachmentItem | undefined> }) {
  const presented = usePanePresentation(() => props.options.transcriptVisible ?? true);
  return (
    <div class="chat-image-frame chat-video-preview">
      <Show when={props.item()}>
        {(item) => (
          <Show when={presented()}>
            <MessageAttachment
              item={item()}
              options={props.state().imageRenderOptions}
              onOpenSidebar={props.onOpenSidebar}
              onAssistantAttachmentLoaded={props.options.onAssistantAttachmentLoaded}
              presentation="preview"
            />
          </Show>
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
      <VideoPreview {...props} item={() => props.state().videoPreviews[index]} />
    )),
  );
  const hasText = () =>
    Boolean(props.state().bodyMarkdown || props.state().asyncQuestions || props.state().jsonResult);
  return (
    <>
      <Show when={props.state().sourceRole === "assistant"}>
        <For each={props.state().clawHubCards} keyed={(card) => card.id}>
          {(card) => <ChatClawHubCard recommendation={card()} agentId={props.options.agentId} />}
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
        inlineComments={props.state().inlineComments}
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
          <openclaw-chat-tool-content style={{ display: "contents" }}>
            <ExpandedToolCardContent
              card={props.state().singleToolCard!}
              options={props.state().toolRenderOptions}
            />
          </openclaw-chat-tool-content>
        </Show>
      </Show>
      <Show when={props.state().isStandaloneToolMessage && props.state().failedToolCard}>
        <openclaw-chat-tool-outcome style={{ display: "contents" }}>
          <ToolOutcome outcome="failed" exitCode={props.state().failedToolCard!.exitCode} />
        </openclaw-chat-tool-outcome>
      </Show>
    </>
  );
}

function ToolMessageFallback(props: ContentProps) {
  const identity = () => {
    const card = props.state().singleToolCard;
    return card ? resolveToolDisplayIdentity(unwrapToolCallForDisplay(card).name) : null;
  };
  let host: HTMLDivElement | undefined;
  return (
    <div
      ref={(element) => (host = element)}
      class={[
        "chat-tool-msg-collapse chat-tool-msg-collapse--manual",
        { "is-open": props.state().toolMessageExpanded },
      ]}
    >
      <ChatImportBoundary
        identity={[props.options.sessionKey, props.messageKey]}
        connected={() => Boolean(host?.isConnected)}
        fallback={() => (
          <button
            class="chat-inline-disclosure chat-tool-msg-summary"
            type="button"
            disabled
            aria-busy="true"
          >
            <span class="chat-tool-msg-summary__icon">
              <Show when={identity()} fallback={<Icon name="zap" />}>
                {(display) => (
                  <ChatToolIcon
                    name={display().icon}
                    tool={{
                      toolName: display().name,
                      pluginToolIcons: props.options.pluginToolIcons,
                    }}
                    style={{ display: "contents" }}
                  />
                )}
              </Show>
            </span>
            <span class="chat-tool-disclosure__content">
              <span class="chat-tool-msg-summary__label">
                {identity() && !props.state().markdown && props.state().images.length === 0
                  ? identity()!.label
                  : t("chat.toolCards.toolOutput")}
              </span>
            </span>
            <span class="chat-tool-row__chevron" aria-hidden="true">
              <Icon name="chevronRight" />
            </span>
          </button>
        )}
      >
        <ToolMessageSummary state={props.state()} options={props.options} />
      </ChatImportBoundary>
      <Show
        when={props.state().toolMessageExpanded}
        fallback={<OmittedMedia items={props.state().omittedMedia} />}
      >
        <div class="chat-tool-msg-body">
          <BubbleContents {...props} />
        </div>
      </Show>
      <For each={props.state().toolCards} keyed={(card) => card.callId ?? card}>
        {(card) => (
          <openclaw-chat-tool-reviews style={{ display: "contents" }}>
            <ToolApprovalReviews card={card()} />
          </openclaw-chat-tool-reviews>
        )}
      </For>
    </div>
  );
}

function ToolMessage(props: ContentProps) {
  const permission = () =>
    readNodePermissionRequest(
      asNullableRecord(props.state().singleToolCard?.details)?.permissionMissing,
    );
  return (
    <Show
      when={permission()}
      fallback={
        <Show when={props.state().singleToolCard} fallback={<ToolMessageFallback {...props} />}>
          {(card) => (
            <PluginSurface
              surface="tool-result"
              props={toolResultSurfaceProps(card(), {
                ...props.state().toolRenderOptions,
                expanded: props.state().toolMessageExpanded,
              })}
              presented={props.options.presented ?? true}
              renderDefault={() => <ToolMessageFallback {...props} />}
            />
          )}
        </Show>
      }
    >
      {(request) => (
        <ChatPermissionCard request={request()} onRetry={props.options.onPermissionRetry} />
      )}
    </Show>
  );
}
