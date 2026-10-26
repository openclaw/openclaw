import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  lazy,
  For,
  Match,
  Show,
  Switch,
  type Accessor,
  refresh,
  untrack,
  useContext,
} from "solid-js";
import { readMessageWorkContext } from "../../../../../src/chat/work-context.js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { assistantMessageIsInterrupted } from "../chat-assistant-reply.ts";
import "../../../components/solid/person-reference.tsx";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import { AsyncQuestionSummary } from "./chat-async-question-summary.tsx";
import { ChatBubbleActivity } from "./chat-bubble-activity-view.tsx";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { OmittedMedia, PairingQrNotices } from "./chat-message-attachment-status-solid.tsx";
import type { GroupedMessageOptions } from "./chat-message-bubble-options.ts";
import {
  prepareGroupedMessage,
  type MessageContentProps as ContentProps,
} from "./chat-message-bubble-presentation.ts";
import {
  AssistantViews,
  BubbleToolCards,
  InlineToolCards,
  ToolMessage,
} from "./chat-message-bubble-tools.tsx";
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
import { ReplyLineView } from "./chat-reply-attribution.tsx";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { TranscriptMessageElementsContext } from "./chat-transcript-message-elements.ts";
import { WorkspaceConflictTranscriptMessage } from "./chat-workspace-conflict.tsx";

registerEnglishCatalog(registerChatToolLabelsEnglish);

registerEnglishCatalog(registerChatComposerEnglish);
registerEnglishCatalog(registerChatSessionEnglish);

registerEnglishCatalog(registerChatMessageMetadataEnglish);

const PluginInlineView = lazy(() => import("../../../plugins/control-ui-inline-view.tsx"), {
  export: "PluginInlineView",
});

/** Message identity owns text/media DOM; option refreshes only publish new facts. */
export function GroupedMessage(props: {
  preparation: ChatMessageRenderPreparation;
  messageKey: string;
  options: GroupedMessageOptions;
  onOpenSidebar?: (content: SidebarContent) => void;
}) {
  const refreshMedia = () => void refresh(state);
  const state = createMemo(() =>
    prepareGroupedMessage(props.preparation, props.messageKey, props.options, props.onOpenSidebar),
  );
  const messageElements = useContext(TranscriptMessageElementsContext);
  // The keyed message owns this DOM registration through acknowledgement and option refreshes.
  const initialMessageKey = untrack(() => props.messageKey);
  // Expiring pairing QR attachments schedule a timer at their resource owner.
  createEffect(
    () => [props.options.mediaOwner, props.messageKey, state().nextPairingQrExpiresAt] as const,
    ([owner, key, expiresAt]) => {
      if (expiresAt === undefined) {
        return undefined;
      }
      observeChatMediaResourceSubscriber(owner, refreshMedia);
      schedulePairingQrExpiryRefresh(key, expiresAt, refreshMedia);
      return () => releaseChatMediaResourceOwner(refreshMedia);
    },
  );
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
                      <ToolMessage
                        {...props}
                        state={state}
                        renderContents={() => <BubbleContents {...props} state={state} />}
                      />
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
                <Show when={readMessageWorkContext(state().message)}>
                  <MessageWorkContext message={state().message} />
                </Show>
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
  const parentPresented = useContext(ContentPresentation);
  // Retained rows can resume with equal props; the parent owns that presentation transition.
  const presented = usePanePresentation(
    () => parentPresented() && (props.options.transcriptVisible ?? true),
  );
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
      <Show
        when={props.state().isStandaloneToolMessage && props.state().assistantViewBlocks.length > 0}
      >
        <AssistantViews {...props} />
      </Show>
      <Show when={props.state().reasoningMarkdown}>
        <MessageReasoning state={props.state} options={props.options} />
      </Show>
      <Show
        when={
          !props.state().isStandaloneToolMessage && props.state().assistantViewBlocks.length > 0
        }
      >
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
      <For each={props.state().inlineViewBlocks} keyed={(block) => block.toolCallId}>
        {(block) => (
          <ChatLazyBoundary>
            <PluginInlineView
              block={block()}
              sessionKey={props.options.sessionKey ?? ""}
              agentId={props.options.agentId}
              presented={props.options.mediaReadAllowed !== false && props.options.presented}
            />
          </ChatLazyBoundary>
        )}
      </For>
      <Show when={props.state().hasToolCards || props.state().failedToolCard}>
        <BubbleToolCards {...props} />
      </Show>
      <Show
        when={
          !props.state().hasToolCards &&
          asNullableRecord(asNullableRecord(props.state().message)?.["__openclaw"])
            ?.catalogTruncated === true
        }
      >
        <p role="status">{t("chat.catalogOutputTruncated")}</p>
      </Show>
    </>
  );
}
