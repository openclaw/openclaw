import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Match, Show, Switch, createMemo, onCleanup, refresh } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import "./chat-audio-player.tsx";
import "./chat-svg-attachment.tsx";
import "./chat-video-player.tsx";
import {
  isCrossOriginHttpSource,
  safeAttachmentHref,
  safePlainTextAttachmentHref,
  safeMediaAttachmentHref,
} from "./chat-attachment-href.ts";
import {
  shouldDeferAttachmentCard,
  type AttachmentAdmission,
} from "./chat-message-attachment-admission-model.ts";
import { ChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";
import { isManagedOutgoingMediaSource } from "./chat-message-attachment-availability.ts";
import { resolveAttachmentSource, readAttachmentSource } from "./chat-message-attachment-source.ts";
import { AssistantAttachmentStatusCard } from "./chat-message-attachment-status-solid.tsx";
import { attachmentFailureReason } from "./chat-message-attachment-status.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { isLocalAssistantAttachmentSource } from "./chat-message-local-media.ts";
import {
  resolveAttachmentImageKind,
  observeChatMediaResourceSubscriber,
  releaseChatMediaResourceOwner,
  type AttachmentItem,
  type AssistantAttachmentItem,
  type ImageRenderOptions,
  type MessageMediaAction,
} from "./chat-message-media.ts";
import { MessageVideoPreview } from "./chat-message-video-preview-solid.tsx";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { ChatPastedText } from "./chat-pasted-text.tsx";
import { isSentCommentAttachment } from "./chat-sent-comments.ts";
import { SentCommentAttachments } from "./chat-sent-comments.tsx";
import type { AttachmentSidebarState, SidebarContent } from "./chat-sidebar-content-types.ts";
import { videoLightboxItem } from "./chat-video-lightbox-source.ts";

type CustomElementProps<T extends HTMLElement> = SolidJSX.HTMLAttributes<T> & {
  [K in keyof T as `prop:${Extract<K, string>}`]?: T[K];
};
declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-audio-player": CustomElementProps<
        HTMLElementTagNameMap["openclaw-chat-audio-player"]
      >;
      "openclaw-chat-video-player": CustomElementProps<
        HTMLElementTagNameMap["openclaw-chat-video-player"]
      >;
      "openclaw-chat-svg-attachment": CustomElementProps<
        HTMLElementTagNameMap["openclaw-chat-svg-attachment"]
      >;
    }
  }
}

type AttachmentProps = {
  options: ImageRenderOptions;
  onOpenSidebar?: (content: SidebarContent) => void;
  onAssistantAttachmentLoaded?: () => void;
};
export type MessageAttachmentProps = AttachmentProps & {
  item: AssistantAttachmentItem;
  presentation?: "inline" | "card" | "preview";
};

export function AssistantAttachments(
  props: AttachmentProps & {
    attachments: AssistantAttachmentItem[];
    inlinePlayback?: boolean;
    inlineComments?: boolean;
  },
): SolidJSX.Element {
  const comments = () =>
    props.inlinePlayback !== false ? [] : props.attachments.filter(isSentCommentAttachment);
  const files = () =>
    props.attachments.filter(
      (item) => props.inlinePlayback !== false || !isSentCommentAttachment(item),
    );
  const refreshComments = () => void refresh(commentSources);
  const resolveComment = (item: AttachmentItem) => {
    observeChatMediaResourceSubscriber(props.options.mediaOwner, refreshComments);
    const resolved = resolveAttachmentSource(item.attachment, {
      ...props.options,
      onMediaChange: refreshComments,
    });
    return {
      identity: item.attachment.url,
      ...(resolved.status === "available"
        ? {
            src:
              /^data:text\/plain;base64,[a-z0-9+/]*={0,2}$/i.test(resolved.source.src) ||
              (safeAttachmentHref(resolved.source.src) &&
                !isCrossOriginHttpSource(resolved.source.src))
                ? resolved.source.src
                : undefined,
            sizeBytes: resolved.source.sizeBytes,
          }
        : { pending: resolved.status === "checking" }),
      fallback: () => (
        <MessageAttachment
          item={item}
          options={props.options}
          onOpenSidebar={props.onOpenSidebar}
          onAssistantAttachmentLoaded={props.onAssistantAttachmentLoaded}
          presentation="card"
        />
      ),
    };
  };
  const commentSources = createMemo(
    () => new Map(comments().map((item) => [item, resolveComment(item)])),
    { lazy: true },
  );
  onCleanup(() => releaseChatMediaResourceOwner(refreshComments));
  return (
    <Show when={props.attachments.length}>
      <div
        class={[
          "chat-assistant-attachments",
          {
            "chat-assistant-attachments--preview-chips":
              props.inlinePlayback === false &&
              (comments().length > 0 || files().some(isSentPastedTextAttachment)),
          },
        ]}
      >
        <SentCommentAttachments
          comments={comments()}
          inline={props.inlineComments && files().length === 0}
          options={props.options}
          resolve={(item) => commentSources().get(item)!}
        />
        <For each={files()} keyed={false}>
          {(item) => {
            const presentation = (): "inline" | "card" => {
              const current = item();
              return props.inlinePlayback !== false ||
                (current.type === "attachment" &&
                  current.attachment.kind === "audio" &&
                  current.attachment.isVoiceNote)
                ? "inline"
                : "card";
            };
            return (
              <MessageAttachment
                item={item()}
                options={props.options}
                onOpenSidebar={props.onOpenSidebar}
                onAssistantAttachmentLoaded={props.onAssistantAttachmentLoaded}
                presentation={presentation()}
              />
            );
          }}
        </For>
      </div>
    </Show>
  );
}

export function MessageAttachment(props: MessageAttachmentProps): SolidJSX.Element {
  return (
    <Show
      when={props.item.type === "attachment" && props.item}
      fallback={
        <AssistantAttachmentStatusCard
          label={props.item.attachment.label}
          mimeType={props.item.attachment.mimeType}
          badge={t("chat.attachments.notSent")}
          reason={
            props.item.type === "attachment_error"
              ? attachmentFailureReason(props.item.attachment.code)
              : undefined
          }
        />
      }
    >
      {(item) => {
        const content = (admission?: AttachmentAdmission) => (
          <AttachmentContent
            item={item()}
            options={props.options}
            onOpenSidebar={props.onOpenSidebar}
            onAssistantAttachmentLoaded={props.onAssistantAttachmentLoaded}
            presentation={props.presentation}
            admission={admission}
          />
        );
        return (
          <Show
            when={shouldDeferAttachmentCard(item(), props.presentation ?? "inline")}
            fallback={content()}
          >
            <ChatAttachmentAdmission
              attachments={[item().attachment]}
              options={props.options}
              render={content}
            />
          </Show>
        );
      }}
    </Show>
  );
}

function prepareAttachment(
  input: AttachmentProps & {
    item: AttachmentItem;
    presentation?: "inline" | "card" | "preview";
    admission?: AttachmentAdmission;
  },
) {
  const { item, options, admission, onOpenSidebar } = input;
  const { onRequestOpenImage, onOpenImage, resolveArtifactDownload } = options;
  const { attachment } = item;
  const pastedText = input.presentation === "card" && isSentPastedTextAttachment(item);
  const imageAttachment = resolveAttachmentImageKind(attachment) === "svg";
  const resolved = admission?.observeElement
    ? undefined
    : resolveAttachmentSource(attachment, options);
  const media = resolved?.status === "available" ? resolved.source : undefined;
  const attachmentUrl = media?.src ?? "";
  const safeAttachmentUrl =
    attachment.kind === "audio" || attachment.kind === "video"
      ? safeMediaAttachmentHref(attachmentUrl, attachment.kind)
      : pastedText
        ? safePlainTextAttachmentHref(attachmentUrl)
        : safeAttachmentHref(attachmentUrl);
  const openVideoOverlay =
    attachment.kind === "video" && onOpenImage && safeAttachmentUrl
      ? (src: string) => {
          const requestVersion = onRequestOpenImage?.();
          const videoItem = (video: AttachmentItem["attachment"], messageId = options.messageId) =>
            videoLightboxItem(
              video,
              (onMediaChange) =>
                resolveAttachmentSource(video, { ...options, messageId, onMediaChange }),
              options.mediaOwner,
            );
          const membership = options.galleryVideos?.(item);
          const overlayItem = {
            ...videoItem(attachment),
            src,
            originalSrc: safeAttachmentUrl,
            ...(membership && membership.index >= 0 && membership.items.length > 1
              ? {
                  gallery: {
                    index: membership.index,
                    items: membership.items.map(
                      ({ attachment: video, messageId }) =>
                        async () =>
                          videoItem(video, messageId),
                    ),
                  },
                }
              : {}),
          };
          onOpenImage(overlayItem, requestVersion);
        }
      : undefined;
  const hasLiveSidebarSource =
    isLocalAssistantAttachmentSource(attachment.url) ||
    (isManagedOutgoingMediaSource(attachment.url) &&
      Boolean(attachment.artifactId && resolveArtifactDownload));
  const openAttachmentSidebar =
    onOpenSidebar && (hasLiveSidebarSource || safeAttachmentUrl || pastedText)
      ? () =>
          onOpenSidebar({
            kind: "attachment",
            attachmentKind: attachment.kind,
            title: attachment.label,
            ...(hasLiveSidebarSource ? {} : { src: safeAttachmentUrl }),
            mimeType: attachment.mimeType,
            ...(pastedText ? { plainText: true } : {}),
            sourceIdentity: attachment.url,
            readForAttachment: (runtime, signal, maxBytes) =>
              readAttachmentSource(
                attachment,
                { ...options, ...runtime, messageId: options.messageId },
                signal,
                maxBytes,
              ),
            playback: media?.playback,
            authToken: media?.authToken,
            sizeBytes: media?.sizeBytes,
            durationMs: media?.durationMs,
            width: media?.width,
            height: media?.height,
            voiceNote: attachment.isVoiceNote === true,
            ...(hasLiveSidebarSource
              ? {
                  resolveSource: (sidebarUpdate, runtime): AttachmentSidebarState => {
                    const next = resolveAttachmentSource(attachment, {
                      ...runtime,
                      messageId: options.messageId,
                      onMediaChange: sidebarUpdate,
                    });
                    if (next.status === "available") {
                      return { status: "ready", ...next.source };
                    }
                    if (next.status === "checking") {
                      return { status: "pending" };
                    }
                    return next.error
                      ? {
                          status: "error",
                          reason: next.reason ?? t("chat.attachments.unavailable"),
                          onRetry: next.onRetry,
                        }
                      : { status: "unavailable", onRetry: next.onRetry };
                  },
                }
              : {}),
          })
      : undefined;
  return {
    attachment,
    pastedText,
    imageAttachment,
    resolved,
    media,
    attachmentUrl,
    safeAttachmentUrl,
    openVideoOverlay,
    openAttachmentSidebar,
  };
}

function AttachmentContent(
  props: AttachmentProps & {
    item: AttachmentItem;
    presentation?: "inline" | "card" | "preview";
    admission?: AttachmentAdmission;
  },
): SolidJSX.Element {
  const refreshAttachment = () => void refresh(model);
  const model = createMemo(() => {
    observeChatMediaResourceSubscriber(props.options.mediaOwner, refreshAttachment);
    return prepareAttachment({
      ...props,
      options: { ...props.options, onMediaChange: refreshAttachment },
    });
  });
  onCleanup(() => releaseChatMediaResourceOwner(refreshAttachment));
  const attachment = () => model().attachment;
  const unavailable = () =>
    !model().pastedText &&
    (model().resolved?.status === "unavailable" ||
      (model().resolved?.status === "checking" && !props.admission));
  const card = () => (
    <CompactAttachmentCard
      kind={attachment().kind}
      label={attachment().label}
      mimeType={attachment().mimeType}
      sizeBytes={model().media?.sizeBytes ?? attachment().sizeBytes}
      downloadHref={model().safeAttachmentUrl}
      downloadPending={Boolean(props.admission && !model().media)}
      downloadPendingFocusable={Boolean(props.admission)}
      onExpand={model().openAttachmentSidebar}
      voiceNote={attachment().isVoiceNote === true}
      elementRef={props.admission?.observeElement}
      onFocus={props.admission?.onAdmit}
    />
  );
  const scope = () =>
    JSON.stringify([
      attachment().url,
      props.options.sessionKey,
      props.options.agentId,
      props.options.connectionEpoch,
      props.options.resourceBasePath,
      props.options.authToken,
      props.options.policyKey,
    ]);
  const title = () => attachment().label.trim() || t("chat.imageLightbox.untitled");
  const pastedTextSource = () => {
    const sourceUrl = model().safeAttachmentUrl;
    return sourceUrl && !isCrossOriginHttpSource(sourceUrl) ? sourceUrl : undefined;
  };
  const ready = () => !props.admission || Boolean(model().media);
  return (
    <Switch fallback={card()}>
      <Match when={unavailable()}>
        <AssistantAttachmentStatusCard
          label={attachment().label}
          mimeType={attachment().mimeType}
          badge={
            model().resolved?.status === "unavailable" ? t("chat.attachments.unavailable") : ""
          }
          reason={model().resolved?.reason}
          onRetry={model().resolved?.onRetry}
          onAllow={model().imageAttachment ? model().resolved?.onAllow : undefined}
          path={isLocalAssistantAttachmentSource(attachment().url) ? attachment().url : undefined}
        />
      </Match>
      <Match when={model().pastedText}>
        <ChatPastedText
          src={pastedTextSource()}
          sizeBytes={model().media?.sizeBytes ?? attachment().sizeBytes}
          scope={scope()}
          onOpen={model().openAttachmentSidebar}
          admission={props.admission}
        />
      </Match>
      <Match when={ready() && model().imageAttachment}>
        <openclaw-chat-svg-attachment
          prop:src={model().attachmentUrl}
          prop:sourceIdentity={attachment().url}
          prop:label={title()}
          prop:mimeType={attachment().mimeType ?? "image/svg+xml"}
          prop:sizeBytes={model().media?.sizeBytes}
          prop:downloadHref={safeAttachmentHref(model().attachmentUrl)}
          prop:onOpen={(src: string, release: () => void) =>
            openResolvedImage(
              props.options.onOpenImage,
              src,
              title(),
              release,
              props.options.onRequestOpenImage?.(),
            )
          }
          prop:onExpand={model().openAttachmentSidebar}
          prop:onMediaLoaded={props.onAssistantAttachmentLoaded}
        />
      </Match>
      <Match
        when={
          ready() &&
          (attachment().kind === "audio" || attachment().kind === "video") &&
          !model().safeAttachmentUrl
        }
      >
        <AssistantAttachmentStatusCard
          label={attachment().label}
          mimeType={attachment().mimeType}
          badge={t("chat.attachments.unavailable")}
          reason={t("chat.attachments.previewUnavailable")}
        />
      </Match>
      <Match
        when={
          ready() && (props.presentation ?? "inline") === "inline" && attachment().kind === "audio"
        }
      >
        <openclaw-chat-audio-player
          prop:src={model().safeAttachmentUrl}
          prop:sourceIdentity={attachment().url}
          prop:label={attachment().label}
          prop:mimeType={attachment().mimeType ?? ""}
          prop:playback={model().media?.playback}
          prop:authToken={model().media?.authToken}
          prop:sizeBytes={model().media?.sizeBytes}
          prop:serverDurationMs={model().media?.durationMs}
          prop:voiceNote={attachment().isVoiceNote === true}
          prop:onExpand={attachment().isVoiceNote ? undefined : model().openAttachmentSidebar}
          prop:onMediaLoaded={props.onAssistantAttachmentLoaded}
        />
      </Match>
      <Match
        when={
          ready() && (props.presentation ?? "inline") === "inline" && attachment().kind === "video"
        }
      >
        <openclaw-chat-video-player
          prop:src={model().safeAttachmentUrl}
          prop:sourceIdentity={attachment().url}
          prop:label={attachment().label}
          prop:mimeType={attachment().mimeType ?? ""}
          prop:playback={model().media?.playback}
          prop:authToken={model().media?.authToken}
          prop:sizeBytes={model().media?.sizeBytes}
          prop:mediaWidth={model().media?.width}
          prop:mediaHeight={model().media?.height}
          prop:onExpand={model().openVideoOverlay}
          prop:onFallbackExpand={model().openAttachmentSidebar}
          prop:onMediaLoaded={props.onAssistantAttachmentLoaded}
        />
      </Match>
      <Match
        when={
          ready() &&
          props.presentation === "preview" &&
          attachment().kind === "video" &&
          model().media?.playback === "native" &&
          model().safeAttachmentUrl &&
          model().openAttachmentSidebar
        }
      >
        <MessageVideoPreview
          key={JSON.stringify([
            props.options.resourceBasePath ?? "",
            props.options.authToken?.trim() ?? "",
            props.options.sessionKey,
            props.options.agentId,
            props.options.policyKey,
            props.options.connectionEpoch ?? 0,
            attachment().url,
            attachment().artifactId,
            model().safeAttachmentUrl,
            400,
            225,
          ])}
          src={model().safeAttachmentUrl!}
          label={attachment().label}
          onOpen={() => model().openAttachmentSidebar?.()}
          fallback={card()}
        />
      </Match>
    </Switch>
  );
}

/** Catalog rows retain the native admission, source, retry and sidebar policies. */
export function MessageAttachmentAction(
  props: AttachmentProps & {
    item: AssistantAttachmentItem;
    render: (action: () => MessageMediaAction) => SolidJSX.Element;
  },
): SolidJSX.Element {
  return (
    <Show
      when={props.item.type === "attachment" && props.item}
      fallback={props.render(() => ({
        pending: false,
        reason:
          props.item.type === "attachment_error"
            ? attachmentFailureReason(props.item.attachment.code)
            : undefined,
      }))}
    >
      {(item) => (
        <ChatAttachmentAdmission
          attachments={[item().attachment]}
          options={props.options}
          render={(admission) => (
            <AttachmentActionContent
              item={item()}
              options={props.options}
              onOpenSidebar={props.onOpenSidebar}
              admission={admission}
              render={props.render}
            />
          )}
        />
      )}
    </Show>
  );
}

function AttachmentActionContent(
  props: AttachmentProps & {
    item: AttachmentItem;
    admission: AttachmentAdmission;
    render: (action: () => MessageMediaAction) => SolidJSX.Element;
  },
): SolidJSX.Element {
  const refreshAttachment = () => void refresh(model);
  const model = createMemo(() => {
    observeChatMediaResourceSubscriber(props.options.mediaOwner, refreshAttachment);
    return prepareAttachment({
      ...props,
      presentation: "card",
      options: { ...props.options, onMediaChange: refreshAttachment },
    });
  });
  onCleanup(() => releaseChatMediaResourceOwner(refreshAttachment));
  const action = createMemo<MessageMediaAction>(() => ({
    pending: !model().resolved || model().resolved?.status === "checking",
    reason:
      model().resolved?.status === "unavailable"
        ? (model().resolved?.reason ?? t("chat.attachments.unavailable"))
        : undefined,
    onOpen: model().resolved?.status === "unavailable" ? undefined : model().openAttachmentSidebar,
    onRetry: model().resolved?.status === "unavailable" ? model().resolved?.onRetry : undefined,
    onAllow:
      model().imageAttachment && model().resolved?.status === "unavailable"
        ? model().resolved?.onAllow
        : undefined,
    observeElement: props.admission.observeElement,
    onFocus: model().resolved?.status === "unavailable" ? undefined : props.admission.onAdmit,
  }));
  return props.render(action);
}
