import { createMemo, Errored, Loading, Match, onCleanup, refresh, Show, Switch } from "solid-js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/canvas-embed-policy.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { isSvgImageMediaPath, isTextAttachment } from "../../../lib/media-file-extension.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { AttachmentStateCard, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import "./chat-audio-player.tsx";
import "./chat-video-player.tsx";
import type { AttachmentDownload } from "./chat-attachment-download.ts";
import {
  isCrossOriginHttpSource,
  safeAttachmentHref,
  safePlainTextAttachmentHref,
  safeMediaAttachmentHref,
} from "./chat-attachment-href.ts";
import type { FileSessionAttachment } from "./chat-file-session-attachment.ts";
import { FileSessionMenu } from "./chat-file-session-menu.tsx";
import { openResolvedImage } from "./chat-image-presentation.ts";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import { ChatPdfPreview, isPdfAttachment } from "./chat-pdf-preview.tsx";
import type {
  AttachmentSidebarRuntime,
  SidebarContent,
  MobileFileBack,
} from "./chat-sidebar-content-types.ts";
import {
  SidebarFileMobileRail,
  SidebarFileMobileImageControls,
} from "./chat-sidebar-file-mobile.tsx";
import { ChatTextAttachment } from "./chat-text-attachment.tsx";

registerEnglishCatalog(registerChatMediaEnglish);

type SidebarAttachmentProps = {
  content: Extract<SidebarContent, { kind: "attachment" }>;
  runtime: AttachmentSidebarRuntime;
  embedSandboxMode: EmbedSandboxMode;
  download?: AttachmentDownload;
  mobile?: boolean;
  attachment?: FileSessionAttachment;
  back?: MobileFileBack;
  onOpenImage?: (item: ImageLightboxItem) => void;
};

function prepareAttachment(input: SidebarAttachmentProps, onSourceChange: () => void) {
  const content = input.content;
  const resolution = content.resolveSource?.(onSourceChange, input.runtime);
  const source = resolution ? (resolution.status === "ready" ? resolution : null) : content;
  const mimeType = content.mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const kind: NonNullable<SidebarAttachmentProps["content"]["attachmentKind"]> =
    content.attachmentKind === "video" || mimeType.startsWith("video/")
      ? "video"
      : content.attachmentKind === "audio" || mimeType.startsWith("audio/")
        ? "audio"
        : content.attachmentKind === "image" || mimeType.startsWith("image/")
          ? "image"
          : "document";
  const src = (
    content.plainText
      ? safePlainTextAttachmentHref
      : kind === "audio" || kind === "video"
        ? safeMediaAttachmentHref
        : safeAttachmentHref
  )(source?.src ?? "");
  const pending = resolution?.status === "pending";
  const inferTypeFromExtension = !mimeType || mimeType === "application/octet-stream";
  const blockedExternalSvg =
    (mimeType === "image/svg+xml" ||
      (inferTypeFromExtension &&
        (isSvgImageMediaPath(content.sourceIdentity ?? "", undefined) ||
          isSvgImageMediaPath(src ?? "", undefined) ||
          isSvgImageMediaPath(content.title, undefined)))) &&
    isCrossOriginHttpSource(src ?? "");
  const imagePreview = (src || pending) && !blockedExternalSvg && kind === "image";
  const width = source?.width ?? content.width;
  const height = source?.height ?? content.height;
  return {
    source,
    mimeType,
    kind,
    src,
    pending,
    imagePreview,
    ratio: width && height ? `${width} / ${height}` : undefined,
    sourceIdentity: [
      input.runtime.connectionEpoch ?? "",
      input.runtime.agentId ?? "",
      input.runtime.sessionKey ?? "",
      content.sourceIdentity ?? src ?? "",
    ].join("\u0000"),
    error: resolution?.status === "error" ? resolution.reason : undefined,
    retry:
      resolution?.status === "error" || resolution?.status === "unavailable"
        ? resolution.onRetry
        : undefined,
  };
}

export function SidebarAttachment(props: SidebarAttachmentProps) {
  // Download-only attachments never resolve preview sources.
  return (
    <>
      <Show when={!props.mobile && props.attachment}>
        <div class="sidebar-file-view__path-bar session-panel-rail" data-presentation="desktop">
          <span class="sidebar-file-view__path-field">{props.content.title}</span>
          <div class="session-panel-rail__actions">
            <FileSessionMenu attachment={props.attachment} />
          </div>
        </div>
      </Show>
      <Show
        when={props.content.download && props.download}
        fallback={<AttachmentPreview {...props} />}
      >
        {(download) => (
          <>
            <Show when={props.mobile}>
              <SidebarFileMobileRail
                name={props.content.title}
                identity={props.content.sourceIdentity ?? props.content.title}
                back={props.back}
                attachment={props.attachment}
                actions={
                  <button
                    type="button"
                    class="sidebar-file-mobile__button"
                    aria-label={t("chat.mediaPlayer.download", { filename: props.content.title })}
                    aria-busy={download().pending ? "true" : "false"}
                    disabled={download().pending}
                    onClick={() => void download().onDownload()}
                  >
                    <Icon name="download" />
                  </button>
                }
              />
            </Show>
            <CompactAttachmentCard
              kind="document"
              label={props.content.title}
              mimeType={props.content.mimeType ?? undefined}
              sizeBytes={props.content.sizeBytes}
              onDownload={() => void download().onDownload()}
              downloadPending={download().pending}
            />
            <Loading on={download().completion}>
              <Errored fallback={(error) => <div role="alert">{formatUiError(error())}</div>}>
                {download().outcome()}
              </Errored>
            </Loading>
          </>
        )}
      </Show>
    </>
  );
}

function AttachmentPreview(props: SidebarAttachmentProps) {
  const sourceKey = createMemo(
    () => ({
      resolver: props.content.resolveSource,
      identity: props.content.sourceIdentity ?? props.content.src,
    }),
    {
      equals: (previous, next) =>
        previous.resolver === next.resolver && previous.identity === next.identity,
    },
  );
  const sourceModel = createMemo(() => {
    sourceKey();
    const sourceChanged = () => void refresh(currentModel);
    // Resource notifications refresh the model without retiring its subscription.
    onCleanup(() => releaseChatMediaResourceOwner(sourceChanged));
    const currentModel = createMemo(() => prepareAttachment(props, sourceChanged));
    return currentModel;
  });
  const model = () => sourceModel()();
  const mediaProps = () => ({
    "prop:sourceIdentity": props.content.sourceIdentity ?? props.content.src ?? model().src ?? "",
    "prop:label": props.content.title,
    "prop:mimeType": props.content.mimeType ?? "",
    "prop:playback": model().source?.playback ?? props.content.playback ?? "native",
    "prop:authToken": model().source?.authToken ?? null,
    "prop:sizeBytes": model().source?.sizeBytes ?? props.content.sizeBytes,
  });
  const preview = (
    <Switch
      fallback={
        <CompactAttachmentCard
          kind={props.content.attachmentKind ?? "document"}
          label={props.content.title}
          mimeType={props.content.mimeType ?? undefined}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
          downloadHref={model().src ?? undefined}
        />
      }
    >
      <Match
        when={
          (model().src || model().pending) &&
          model().kind === "document" &&
          isPdfAttachment(model().mimeType, props.content.title) &&
          !isCrossOriginHttpSource(model().src ?? "")
        }
      >
        <ChatPdfPreview
          src={model().src ?? ""}
          sourceIdentity={model().sourceIdentity}
          label={props.content.title}
          mimeType={props.content.mimeType ?? ""}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
        />
      </Match>
      <Match
        when={
          (model().src || model().pending) &&
          isTextAttachment(model().mimeType, props.content.title) &&
          !isCrossOriginHttpSource(model().src ?? "")
        }
      >
        <ChatTextAttachment
          mobile={props.mobile === true}
          plainText={props.content.plainText ?? false}
          actions={props.content.renderActions?.()}
          embedSandboxMode={props.embedSandboxMode}
          src={model().src ?? ""}
          sourceIdentity={model().sourceIdentity}
          label={props.content.title}
          mimeType={props.content.mimeType ?? ""}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
        />
      </Match>
      <Match when={model().kind === "video" && (model().src || model().pending)}>
        <openclaw-chat-video-player
          prop:src={model().src ?? ""}
          prop:preview={true}
          {...mediaProps()}
          prop:mediaWidth={model().source?.width ?? props.content.width}
          prop:mediaHeight={model().source?.height ?? props.content.height}
        />
      </Match>
      <Match when={!model().src || model().imagePreview}>
        <AttachmentStateCard
          kind={model().kind}
          label={props.content.title}
          mimeType={props.content.mimeType ?? undefined}
          sizeBytes={model().source?.sizeBytes ?? props.content.sizeBytes}
          downloadHref={model().src ?? undefined}
          downloadPending={model().pending}
          imagePreview={Boolean(model().imagePreview)}
          previewRatio={model().ratio}
          error={model().error}
          onRetry={model().retry}
        >
          <Show when={props.mobile && props.onOpenImage && model().imagePreview && model().src}>
            <SidebarFileMobileImageControls
              name={props.content.title}
              onExpand={() =>
                openResolvedImage(props.onOpenImage, model().src!, props.content.title)
              }
            />
          </Show>
        </AttachmentStateCard>
      </Match>
      <Match when={model().kind === "audio"}>
        <openclaw-chat-audio-player
          prop:src={model().src ?? ""}
          {...mediaProps()}
          prop:serverDurationMs={model().source?.durationMs ?? props.content.durationMs}
          prop:voiceNote={props.content.voiceNote === true}
        />
      </Match>
    </Switch>
  );
  return (
    <>
      <Show when={props.mobile}>
        <SidebarFileMobileRail
          name={props.content.title}
          identity={props.content.sourceIdentity ?? props.content.title}
          back={props.back}
          attachment={props.attachment}
          actions={
            <Show when={model().src}>
              {(src) => (
                <a
                  class="sidebar-file-mobile__button"
                  href={src()}
                  download={props.content.title}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("chat.mediaPlayer.download", { filename: props.content.title })}
                >
                  <Icon name="download" />
                </a>
              )}
            </Show>
          }
        />
      </Show>
      <div
        class={props.mobile ? "sidebar-file-mobile__body" : undefined}
        style={{ display: props.mobile ? undefined : "contents" }}
      >
        {preview}
      </div>
    </>
  );
}
