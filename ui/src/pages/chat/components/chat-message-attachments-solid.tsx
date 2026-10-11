import type { JSX as SolidJSX } from "@solidjs/web";
import { For, Match, Show, Switch, createMemo } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";
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
import { resolveAttachmentSource } from "./chat-message-attachment-source.ts";
import { AssistantAttachmentStatusCard } from "./chat-message-attachment-status-solid.tsx";
import { attachmentFailureReason } from "./chat-message-attachment-status.ts";
import { openResolvedImage } from "./chat-message-image-open.ts";
import { isLocalAssistantAttachmentSource } from "./chat-message-local-media.ts";
import {
  resolveAttachmentImageKind,
  type AttachmentItem,
  type AssistantAttachmentItem,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import { MessageVideoPreview } from "./chat-message-video-preview-solid.tsx";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { isSentCommentAttachment, renderSentCommentAttachments } from "./chat-sent-comments.ts";
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
      "openclaw-chat-pasted-text": HTMLAttributes<HTMLElement> & {
        "prop:src"?: string;
        "prop:sizeBytes"?: number;
        "prop:scope"?: string;
        "prop:onOpen"?: () => void;
        "prop:admission"?: AttachmentAdmission;
      };
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
  props: AttachmentProps & { attachments: AssistantAttachmentItem[]; inlinePlayback?: boolean },
): SolidJSX.Element {
  const comments = () =>
    props.inlinePlayback !== false ? [] : props.attachments.filter(isSentCommentAttachment);
  const files = () =>
    props.attachments.filter(
      (item) => props.inlinePlayback !== false || !isSentCommentAttachment(item),
    );
  const resolveComment = (item: AttachmentItem) => {
    const resolved = resolveAttachmentSource(item.attachment, props.options);
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
      fallback: solidContent(MessageAttachment, {
        item,
        options: props.options,
        onOpenSidebar: props.onOpenSidebar,
        onAssistantAttachmentLoaded: props.onAssistantAttachmentLoaded,
        presentation: "card",
      }),
    };
  };
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
        <LitContent
          value={renderSentCommentAttachments(comments(), props.options, resolveComment)}
        />
        <For each={files()} keyed={false}>
          {(item) => {
            const presentation = createMemo<"inline" | "card">(() => {
              const current = item();
              return props.inlinePlayback !== false ||
                (current.type === "attachment" &&
                  current.attachment.kind === "audio" &&
                  current.attachment.isVoiceNote)
                ? "inline"
                : "card";
            });
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
      {(item) => (
        <Show
          when={shouldDeferAttachmentCard(item(), props.presentation ?? "inline")}
          fallback={
            <AttachmentContent
              item={item()}
              options={props.options}
              onOpenSidebar={props.onOpenSidebar}
              onAssistantAttachmentLoaded={props.onAssistantAttachmentLoaded}
              presentation={props.presentation}
            />
          }
        >
          <ChatAttachmentAdmission
            attachments={[item().attachment]}
            options={props.options}
            render={(admission) => (
              <AttachmentContent
                item={item()}
                options={props.options}
                onOpenSidebar={props.onOpenSidebar}
                onAssistantAttachmentLoaded={props.onAssistantAttachmentLoaded}
                presentation={props.presentation}
                admission={admission}
              />
            )}
          />
        </Show>
      )}
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
          const videoItem = (video: AttachmentItem["attachment"]) =>
            videoLightboxItem(
              video,
              (onRequestUpdate) => resolveAttachmentSource(video, { ...options, onRequestUpdate }),
              options.onRequestUpdate,
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
                      ({ attachment: video }) =>
                        async () =>
                          videoItem(video),
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
                      onRequestUpdate: sidebarUpdate,
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
  const model = createMemo(() => prepareAttachment(props));
  const attachment = () => model().attachment;
  const unavailable = () =>
    !model().pastedText &&
    (model().resolved?.status === "unavailable" ||
      (model().resolved?.status === "checking" && !props.admission));
  const card = () =>
    renderCompactAttachmentCard(
      {
        kind: attachment().kind,
        label: attachment().label,
        mimeType: attachment().mimeType,
        sizeBytes: model().media?.sizeBytes ?? attachment().sizeBytes,
        downloadHref: model().safeAttachmentUrl,
        downloadPending: Boolean(props.admission && !model().media),
        downloadPendingFocusable: Boolean(props.admission),
        onExpand: model().openAttachmentSidebar,
        voiceNote: attachment().isVoiceNote === true,
      },
      props.admission?.observeElement,
      props.admission?.onAdmit,
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
    <Switch fallback={<LitContent value={card()} />}>
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
        <openclaw-chat-pasted-text
          prop:src={pastedTextSource()}
          prop:sizeBytes={model().media?.sizeBytes ?? attachment().sizeBytes}
          prop:scope={scope()}
          prop:onOpen={model().openAttachmentSidebar}
          prop:admission={props.admission}
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
          fallback={<LitContent value={card()} />}
        />
      </Match>
    </Switch>
  );
}
