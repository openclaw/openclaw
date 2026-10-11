import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  defineSolidBridge,
  LitContent,
  type SolidBridgeElement,
} from "../../../lit/solid-bridge.ts";
import {
  openAttachmentCardFromClick,
  renderAttachmentCardHeader,
  renderCompactAttachmentCard,
  type AttachmentCardHeaderOptions,
} from "./chat-attachment-card.ts";
import { safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import { ChatAttachmentViewportRef } from "./chat-attachment-viewport.ts";
import type { ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";

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

function ChatVideoPlayerContent(
  props: ChatVideoPlayerProps,
  host: SolidBridgeElement<ChatVideoPlayerProps>,
) {
  host.style.display = "contents";
  // Buffering can lower readyState after the first frame without another loadeddata event.
  const [frameReady, setFrameReady] = createSignal(false);
  const [revision, setRevision] = createSignal(0);
  const sourceController = new ChatMediaSourceController();
  let media: HTMLVideoElement | undefined;
  let mediaVisible = false;
  let active = true;
  const publish = () => setRevision((value) => value + 1);
  const sourceState = () => {
    revision();
    return sourceController;
  };
  const syncSource = () => {
    const currentMedia = media;
    if (!currentMedia || !host.isConnected || !mediaVisible) {
      return;
    }
    // The source effect tracks changes; imperative ref/event calls sample current props.
    const pending = untrack(() =>
      sourceController.sync(
        currentMedia,
        props.src,
        props.sourceIdentity,
        props.playback,
        props.authToken,
      ),
    );
    publish();
    void pending?.then(() => {
      if (active) {
        publish();
      }
    });
  };
  const viewport = new ChatAttachmentViewportRef(() => {
    mediaVisible = true;
    syncSource();
  });
  const sourceSnapshot = createMemo(
    () => [props.src, props.sourceIdentity, props.playback, props.authToken] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  createEffect(sourceSnapshot, ([src]) => {
    if (!src && media) {
      sourceController.cancel();
      sourceController.reset(media);
    }
    if (sourceController.readiness === "unavailable") {
      sourceController.cancel();
      publish();
    }
    syncSource();
  });
  onSettled(syncSource);
  onCleanup(() => {
    active = false;
    sourceController.cancel();
  });
  const setMedia = (element: HTMLVideoElement) => {
    setFrameReady(false);
    media = element;
    syncSource();
  };
  const adoptPendingSource = () => {
    if (!media || !sourceController.applyPendingSource(media)) {
      return false;
    }
    publish();
    return true;
  };
  const expand = () => {
    const source = sourceController.readySource;
    if (!source) {
      return;
    }
    media?.pause();
    // Touch activation need not focus a button; the modal still needs a return target.
    host
      .querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")
      ?.focus({ preventScroll: true });
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
  const preparing = () => sourceState().readiness === "preparing" && !props.preview;
  const loading = () => props.preview && !frameReady();
  const onExpand = () => (props.onExpand && sourceState().readySource ? expand : undefined);
  const dimensions = createMemo(() =>
    props.mediaWidth && props.mediaHeight
      ? { "aspect-ratio": `${props.mediaWidth} / ${props.mediaHeight}` }
      : props.preview
        ? { "aspect-ratio": "16 / 9" }
        : {},
  );
  const Player = () => {
    onCleanup(() => {
      viewport.disconnect();
      mediaVisible = false;
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
        ref={viewport.setElement}
        data-openable={onExpand() ? "" : undefined}
        onClick={(event) => openAttachmentCardFromClick(event, onExpand())}
      >
        <LitContent
          render={() =>
            renderAttachmentCardHeader({
              ...card(),
              downloadPending: props.preview && !downloadHref(),
              loading: loading(),
              expandLabel: t("chat.mediaPlayer.openVideo", { filename: props.label }),
              onExpand: onExpand(),
              visualMode: "preview-with-favicon",
            })
          }
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
            onLoadedData={() => media && setFrameReady(true)}
            onPlaying={() => media && setFrameReady(true)}
            onEmptied={() => media && setFrameReady(false)}
            onLoadedMetadata={() => {
              if (media) {
                sourceController.handleLoadedMetadata(media);
                props.onMediaLoaded?.();
              }
            }}
            onEnded={() => {
              if (media && sourceController.handleEnded(media)) {
                publish();
              }
            }}
            onPlay={adoptPendingSource}
            onSeeking={() => {
              if (!adoptPendingSource() && media?.error && sourceController.handleError(media)) {
                publish();
              }
            }}
            onError={() => {
              if (media) {
                sourceController.handleError(media);
                publish();
              }
            }}
          />
        </div>
      </div>
    );
  };
  return (
    <Show
      when={sourceState().readiness !== "unavailable"}
      fallback={
        <LitContent
          render={() =>
            renderCompactAttachmentCard({ ...card(), onExpand: props.onFallbackExpand })
          }
        />
      }
    >
      <Player />
    </Show>
  );
}

defineSolidBridge("openclaw-chat-video-player", ChatVideoPlayerContent, {
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
