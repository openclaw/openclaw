import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { AttachmentCardHeader, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import {
  openAttachmentCardFromClick,
  type AttachmentCardHeaderOptions,
} from "./chat-attachment-card.ts";
import { attachmentContextCopyRef } from "./chat-attachment-context-copy.ts";
import { safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import { createChatAttachmentViewportRef } from "./chat-attachment-viewport.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceOwner } from "./chat-media-source.ts";

type ChatVideoPlayerProps = {
  src: string;
  preview: boolean;
  sourceIdentity: string;
  label: string;
  mimeType: string;
  playback: ChatMediaPlaybackMode;
  authToken: string | null;
  sizeBytes?: number;
  mediaWidth?: number;
  mediaHeight?: number;
  onExpand?: (src: string) => void;
  onFallbackExpand?: () => void;
  onMediaLoaded?: () => void;
};

const inputHandlers = new WeakMap<HTMLElement, (key: keyof ChatVideoPlayerProps) => void>();

function ChatVideoPlayerContent(
  props: ChatVideoPlayerProps,
  host: SolidBridgeElement<ChatVideoPlayerProps>,
) {
  host.style.display = "contents";
  // Buffering can lower readyState after the first frame without another loadeddata event.
  const [frameReady, setFrameReady] = createSignal(false);
  const sourceController = new ChatMediaSourceOwner();
  const sourceState = projectOwner(sourceController, (owner) => owner);
  let media: HTMLVideoElement | undefined;
  let mediaVisible = false;
  let expandButton: HTMLButtonElement | undefined;
  let active = true;
  const syncSource = () => {
    const currentMedia = media;
    if (!active || !currentMedia || !host.isConnected || !mediaVisible) {
      return;
    }
    // The bridge holds current synchronous inputs for ref, event, and async callbacks.
    void sourceController.sync(
      currentMedia,
      host.src,
      host.sourceIdentity,
      host.playback,
      host.authToken,
    );
  };
  function handleInputsChanged(key: keyof ChatVideoPlayerProps): void {
    if (key !== "src" && key !== "sourceIdentity" && key !== "playback" && key !== "authToken") {
      return;
    }
    if (!host.src && media) {
      sourceController.cancel();
      sourceController.reset(media);
    }
    if (
      sourceController.readiness === "unavailable" ||
      key === "sourceIdentity" ||
      key === "authToken"
    ) {
      sourceController.cancel();
      if (media && !media.paused) {
        media.pause();
      }
    }
    sourceController.queueSync(syncSource);
  }
  onSettled(() => {
    inputHandlers.set(host, handleInputsChanged);
    syncSource();
    return () => {
      active = false;
      inputHandlers.delete(host);
      sourceState.dispose();
      sourceController.cancel();
    };
  });
  const setMedia = (element: HTMLVideoElement) => {
    setFrameReady(false);
    media = element;
    syncSource();
  };
  const expand = () => {
    const source = sourceController.readySource;
    if (!source) {
      return;
    }
    media?.pause();
    // Touch activation need not focus a button; the modal still needs a return target.
    expandButton?.focus({ preventScroll: true });
    props.onExpand?.(source);
  };
  const downloadHref = () => safeMediaAttachmentHref(props.src);
  const card = (): AttachmentCardHeaderOptions => ({
    kind: "video",
    label: props.label,
    mimeType: props.mimeType,
    sizeBytes: props.sizeBytes,
    downloadHref: downloadHref(),
  });
  const preparing = () => sourceState.read().readiness === "preparing" && !props.preview;
  const loading = () => props.preview && !frameReady();
  const onExpand = () => (props.onExpand && sourceState.read().readySource ? expand : undefined);
  const dimensions = () =>
    props.mediaWidth && props.mediaHeight
      ? { "aspect-ratio": `${props.mediaWidth} / ${props.mediaHeight}` }
      : props.preview
        ? { "aspect-ratio": "16 / 9" }
        : {};
  const Player = () => {
    const copyRef = attachmentContextCopyRef(() => ({ name: props.label, href: downloadHref() }));
    const viewport = createChatAttachmentViewportRef(() => {
      mediaVisible = true;
      syncSource();
    });
    onCleanup(() => {
      mediaVisible = false;
      expandButton = undefined;
      const previousMedia = media;
      media = undefined;
      if (previousMedia) {
        // Clear the departed node while retaining unavailable readiness until the source changes.
        sourceController.reset(previousMedia);
      }
    });
    return (
      <div
        class={[
          "chat-assistant-attachment-card chat-assistant-attachment-card--video",
          { "chat-assistant-attachment-card--loading": loading() },
        ]}
        aria-busy={loading() ? "true" : undefined}
        ref={[viewport, copyRef]}
        data-openable={onExpand() ? "" : undefined}
        onClick={(event) => openAttachmentCardFromClick(event, onExpand())}
      >
        <AttachmentCardHeader
          {...card()}
          downloadPending={props.preview && !downloadHref()}
          loading={loading()}
          expandLabel={t("chat.mediaPlayer.openVideo", { filename: props.label })}
          onExpand={onExpand()}
          expandRef={(element) => {
            expandButton = element;
          }}
          visualMode="preview-with-favicon"
        />
        <Show when={preparing()}>
          <div class="chat-assistant-attachment-card__reason chat-media-preparing">
            {t("chat.mediaPlayer.preparing")}
          </div>
        </Show>
        <div class="chat-assistant-video-frame" hidden={preparing()}>
          <Show when={loading()}>
            <div class="chat-video-skeleton" role="status" aria-label={t("common.loading")}>
              <div class="chat-video-skeleton__controls" aria-hidden="true">
                <Icon name="play" />
                <span>
                  0:00<span>/ 0:00</span>
                </span>
                <Icon name="volume2" />
                <Icon name="maximize" />
                <Icon name="moreHorizontal" />
              </div>
              <div class="chat-video-skeleton__timeline skeleton" aria-hidden="true" />
            </div>
          </Show>
          <video
            controls
            aria-label={props.label.trim() || t("chat.attachments.video")}
            preload={props.preview ? "auto" : "metadata"}
            style={dimensions()}
            ref={setMedia}
            onLoadedData={() => setFrameReady(true)}
            onPlaying={() => setFrameReady(true)}
            onEmptied={() => setFrameReady(false)}
            onLoadedMetadata={(event) => {
              sourceController.handleLoadedMetadata(event.currentTarget);
              props.onMediaLoaded?.();
            }}
            onEnded={(event) => sourceController.handleEnded(event.currentTarget)}
            onPlay={(event) => sourceController.applyPendingSource(event.currentTarget)}
            onSeeking={(event) => {
              const currentMedia = event.currentTarget;
              if (!sourceController.applyPendingSource(currentMedia) && currentMedia.error) {
                sourceController.handleError(currentMedia);
              }
            }}
            onError={(event) => sourceController.handleError(event.currentTarget)}
          />
        </div>
      </div>
    );
  };
  return (
    <Show
      when={sourceState.read().readiness !== "unavailable"}
      fallback={<CompactAttachmentCard {...card()} onExpand={props.onFallbackExpand} />}
    >
      <Player />
    </Show>
  );
}

defineSolidBridge("openclaw-chat-video-player", ChatVideoPlayerContent, {
  propertyChanged: (host, key) => inputHandlers.get(host)?.(key),
  properties: {
    src: { default: "" },
    preview: { default: false },
    sourceIdentity: { default: "" },
    label: { default: "" },
    mimeType: { default: "" },
    playback: { default: "native" },
    authToken: { default: null },
    sizeBytes: { default: undefined, type: Number },
    mediaWidth: { default: undefined, type: Number },
    mediaHeight: { default: undefined, type: Number },
    onExpand: { default: undefined, attribute: false },
    onFallbackExpand: { default: undefined, attribute: false },
    onMediaLoaded: { default: undefined, attribute: false },
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-video-player": SolidBridgeElement<ChatVideoPlayerProps>;
  }
}
