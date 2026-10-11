import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { defineSolidBridge, LitContent } from "../../../lit/solid-bridge.ts";
import {
  openAttachmentCardFromClick,
  renderAttachmentCardHeader,
  renderCompactAttachmentCard,
  type AttachmentCardHeaderOptions,
} from "./chat-attachment-card.ts";
import { safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import { ChatAttachmentViewportRef } from "./chat-attachment-viewport.ts";
import {
  canResumeChatAudioPlayback,
  claimChatAudioPlayback,
  releaseChatAudioPlayback,
} from "./chat-audio-coordinator.ts";
import {
  cacheAndRetainChatAudioBlob,
  CHAT_AUDIO_WAVEFORM_MAX_BYTES,
  CHAT_AUDIO_WAVEFORM_SAMPLE_RATE,
  computeChatAudioWaveformPeaks,
  retainCachedChatAudioBlob,
  resampleChatAudioWaveformPeaks,
  shouldFetchChatAudioWaveform,
  type CachedChatAudioBlob,
} from "./chat-audio-waveform.ts";
import { buildChatMediaFetchHeaders, type ChatMediaPlaybackMode } from "./chat-media-playback.ts";
import { ChatMediaSourceController } from "./chat-media-source.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const SEEK_STEP_SECONDS = 5;
const WAVEFORM_FETCH_TIMEOUT_MS = 30_000;
const WAVEFORM_DECODE_DURATION_TOLERANCE = 1.2;

function formatChatMediaTime(seconds: number): string {
  const wholeSeconds = Math.floor(Number.isFinite(seconds) && seconds >= 0 ? seconds : 0);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

type ChatAudioPlayerProps = {
  src: string;
  sourceIdentity: string;
  label: string;
  mimeType: string;
  playback: ChatMediaPlaybackMode;
  authToken: string | null;
  sizeBytes?: number;
  serverDurationMs?: number;
  voiceNote: boolean;
  onExpand?: () => void;
  onMediaLoaded?: () => void;
};

function ChatAudioPlayerContent(
  props: ChatAudioPlayerProps,
  host: SolidBridgeElement<ChatAudioPlayerProps>,
) {
  host.style.display = "contents";
  const [revision, setRevision] = createSignal(0);
  const state: Record<"currentTime" | "duration" | "buffered" | "waveformWidth", number> & {
    playing: boolean;
    muted: boolean;
    waveformPeaks: readonly number[] | null;
  } = {
    currentTime: 0,
    duration: 0,
    buffered: 0,
    playing: false,
    muted: false,
    waveformPeaks: null,
    waveformWidth: 0,
  };
  const publish = () => setRevision((value) => value + 1);
  const updateState = (patch: Partial<typeof state>) => {
    Object.assign(state, patch);
    publish();
  };
  const view = () => {
    revision();
    return state;
  };
  const sourceState = () => {
    revision();
    return sourceController;
  };
  const sourceController = new ChatMediaSourceController();
  const cancelPendingResume = () => sourceController.cancelPendingResume();
  let mediaElement: HTMLAudioElement | null = null;
  let waveformElement: HTMLElement | null = null;
  let waveformResizeObserver: ResizeObserver | null = null;
  let playRequest: Promise<void> | null = null;
  let releaseWaveformBlob: (() => void) | undefined;
  let waveformController: AbortController | null = null;
  let waveformAttempted = false;
  let waveformVisible = false;
  let active = true;
  const viewport = new ChatAttachmentViewportRef(() => {
    waveformVisible = true;
    void prepareWaveformAudio().catch(() => undefined);
  });
  const sourceSnapshot = createMemo(
    () => [props.src, props.sourceIdentity, props.playback, props.authToken] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  createEffect(sourceSnapshot, (next, previous) => {
    if (sourceController.readiness === "unavailable") {
      releaseWaveformBlob?.();
      releaseWaveformBlob = undefined;
      sourceController.cancel();
      publish();
    }
    if (
      previous &&
      (previous[1] !== next[1] || previous[2] !== next[2] || previous[3] !== next[3])
    ) {
      waveformController?.abort();
      waveformController = null;
      releaseWaveformBlob?.();
      releaseWaveformBlob = undefined;
      waveformAttempted = false;
      updateState({ waveformPeaks: null, currentTime: 0, duration: 0, buffered: 0 });
      if (mediaElement && !mediaElement.paused) {
        mediaElement.pause();
        releaseChatAudioPlayback(mediaElement);
      }
    }
    syncSource();
    if (waveformVisible) {
      void prepareWaveformAudio().catch(() => undefined);
    }
  });
  const waveformMetadata = createMemo(() => [props.sizeBytes, props.serverDurationMs] as const, {
    equals: (before, after) => before.every((value, index) => value === after[index]),
  });
  createEffect(waveformMetadata, () => {
    if (waveformVisible) {
      void prepareWaveformAudio().catch(() => undefined);
    }
  });
  onSettled(syncSource);
  onCleanup(() => {
    active = false;
    sourceController.cancel();
  });

  const setMedia = (element: HTMLAudioElement) => {
    mediaElement = element;
    mediaElement.muted = state.muted;
    syncSource();
  };

  const setWaveform = (waveform: HTMLDivElement) => {
    waveformResizeObserver?.disconnect();
    waveformResizeObserver = null;
    waveformElement = waveform;
    updateWaveformWidth(waveform.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    waveformResizeObserver = new ResizeObserver(([entry]) => {
      if (entry && waveformElement === entry.target) {
        updateWaveformWidth(entry.contentRect.width);
      }
    });
    waveformResizeObserver.observe(waveform);
  };

  function updateWaveformWidth(width: number): void {
    const nextWidth = Math.max(0, width);
    if (Math.abs(nextWidth - state.waveformWidth) >= 0.5) {
      updateState({ waveformWidth: nextWidth });
    }
  }

  function syncSource(): void {
    const media = mediaElement;
    if (!media || !active || !host.isConnected || releaseWaveformBlob) {
      return;
    }
    // The source effect tracks changes; imperative ref/event calls sample current props.
    const pending = untrack(() =>
      sourceController.sync(
        media,
        props.src,
        props.sourceIdentity,
        props.playback,
        props.authToken,
      ),
    );
    publish();
    if (!pending && waveformVisible) {
      void prepareWaveformAudio().catch(() => undefined);
    }
    void pending?.then(() => {
      if (active && host.isConnected) {
        publish();
        if (waveformVisible) {
          void prepareWaveformAudio().catch(() => undefined);
        }
      }
    });
  }

  function resolveWaveformCacheKey(): string {
    return untrack(() =>
      [
        props.sourceIdentity.trim(),
        props.playback,
        props.src.trim(),
        props.authToken?.trim() ?? "",
      ].join("\0"),
    );
  }

  function applyPreparedAudio(
    cacheKey: string,
    prepared: { value: CachedChatAudioBlob; release: () => void },
  ): void {
    const media = mediaElement;
    if (!media || cacheKey !== resolveWaveformCacheKey()) {
      prepared.release();
      return;
    }
    releaseWaveformBlob?.();
    releaseWaveformBlob = prepared.release;
    updateState({ waveformPeaks: prepared.value.peaks?.length ? prepared.value.peaks : null });
    if (prepared.value.durationSeconds !== undefined) {
      updateState({ duration: prepared.value.durationSeconds });
    }
    sourceController.updateSource(
      media,
      prepared.value.blobUrl,
      untrack(() => props.sourceIdentity),
    );
  }

  function adoptPreparedAudioForPlayback(): void {
    const media = mediaElement;
    if (!media) {
      return;
    }
    if (!releaseWaveformBlob) {
      const cacheKey = resolveWaveformCacheKey();
      const cached = retainCachedChatAudioBlob(cacheKey);
      if (cached) {
        applyPreparedAudio(cacheKey, cached);
      }
    }
    sourceController.applyPendingSource(media);
  }

  async function prepareWaveformAudio(): Promise<void> {
    const media = mediaElement;
    const source = sourceController.readySource;
    if (!media || !source || releaseWaveformBlob || waveformAttempted) {
      return;
    }
    const cacheKey = resolveWaveformCacheKey();
    const cached = retainCachedChatAudioBlob(cacheKey);
    if (cached) {
      applyPreparedAudio(cacheKey, cached);
      return;
    }
    const { serverDurationMs, sizeBytes, authToken } = untrack(() => ({
      serverDurationMs: props.serverDurationMs,
      sizeBytes: props.sizeBytes,
      authToken: props.authToken,
    }));
    const durationSeconds = serverDurationMs !== undefined ? serverDurationMs / 1_000 : undefined;
    if (
      durationSeconds === undefined ||
      !shouldFetchChatAudioWaveform({ sizeBytes, durationSeconds })
    ) {
      return;
    }
    const AudioContextConstructor = globalThis.AudioContext;
    if (!AudioContextConstructor) {
      return;
    }
    waveformAttempted = true;

    const headers = buildChatMediaFetchHeaders(authToken);
    headers.set("Accept", "audio/*");
    const controller = new AbortController();
    waveformController = controller;
    const timeout = setTimeout(
      () => controller.abort(new DOMException("waveform fetch timed out", "TimeoutError")),
      WAVEFORM_FETCH_TIMEOUT_MS,
    );
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await fetch(source, {
        method: "GET",
        headers,
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) {
        return;
      }
      const boundedBytes = await readResponseBytesWithinLimit(
        response,
        CHAT_AUDIO_WAVEFORM_MAX_BYTES,
      );
      if (!boundedBytes) {
        return;
      }
      bytes = boundedBytes;
    } finally {
      clearTimeout(timeout);
      if (waveformController === controller) {
        waveformController = null;
      }
    }
    const blob = new Blob([bytes], {
      type: response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() || "audio/mpeg",
    });
    const blobUrl = URL.createObjectURL(blob);
    let peaks: readonly number[] | undefined;
    let acceptedDecodedDuration: number | undefined;
    if (shouldFetchChatAudioWaveform({ sizeBytes: bytes.byteLength, durationSeconds })) {
      let context: AudioContext | null = null;
      try {
        // Duration is trusted only from the server-side ffprobe metadata.
        // A 16 kHz decode bounds PCM; >20% duration mismatches are discarded.
        context = new AudioContextConstructor({ sampleRate: CHAT_AUDIO_WAVEFORM_SAMPLE_RATE });
        const decoded = await context.decodeAudioData(bytes.slice(0));
        const decodedDuration = Number.isFinite(decoded.duration) ? decoded.duration : undefined;
        if (
          decodedDuration !== undefined &&
          decodedDuration <= durationSeconds * WAVEFORM_DECODE_DURATION_TOLERANCE
        ) {
          peaks = computeChatAudioWaveformPeaks(decoded);
          acceptedDecodedDuration = decodedDuration;
        }
      } catch {
        // A playable browser source can still use the fetched Blob when Web Audio cannot decode it.
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
    if (!(active && host.isConnected) || cacheKey !== resolveWaveformCacheKey()) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    const retained = cacheAndRetainChatAudioBlob(cacheKey, {
      blobUrl,
      sizeBytes: bytes.byteLength,
      ...(peaks ? { peaks } : {}),
      ...(acceptedDecodedDuration !== undefined
        ? { durationSeconds: acceptedDecodedDuration }
        : {}),
    });
    if (retained) {
      applyPreparedAudio(cacheKey, retained);
    }
  }

  function togglePlayback(): void {
    const media = mediaElement;
    if (!media || sourceController.readiness !== "ready") {
      return;
    }
    if (media.paused) {
      adoptPreparedAudioForPlayback();
      claimChatAudioPlayback(media, cancelPendingResume);
      const playback = media.play();
      const failed = () => {
        releaseChatAudioPlayback(media);
        updateState({ playing: false });
      };
      if (!playRequest) {
        // Invoke play in the click task so strict browser media policies retain user activation.
        playRequest = playback
          .then(() => prepareWaveformAudio().catch(() => undefined))
          .catch(failed)
          .finally(() => {
            playRequest = null;
          });
      } else {
        void playback.catch(failed);
      }
    } else {
      media.pause();
    }
  }

  function seekTo(nextTime: number): void {
    const media = mediaElement;
    if (!media) {
      return;
    }
    if (sourceController.seek(media, Math.min(nextTime, state.duration || nextTime))) {
      updateState({ currentTime: media.currentTime });
    }
  }

  function toggleMuted(): void {
    updateState({ muted: !state.muted });
    if (mediaElement) {
      mediaElement.muted = state.muted;
    }
  }

  function handlePlayerKeydown(event: KeyboardEvent): void {
    const seekTarget = event.target instanceof HTMLInputElement && event.target.type === "range";
    if (event.target !== event.currentTarget && !seekTarget) {
      return;
    }
    if (!seekTarget && event.key === " ") {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      (seekTarget && (event.key === "ArrowDown" || event.key === "ArrowUp"))
    ) {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
      seekTo(state.currentTime + direction * SEEK_STEP_SECONDS);
    }
  }

  function updateBuffered(): void {
    const media = mediaElement;
    if (!media) {
      return;
    }
    if (!state.duration || media.buffered.length === 0) {
      updateState({ buffered: 0 });
      return;
    }
    updateState({
      buffered: Math.min(1, media.buffered.end(media.buffered.length - 1) / state.duration),
    });
  }

  const progress = () =>
    view().duration > 0 ? Math.min(1, view().currentTime / view().duration) : 0;
  const downloadHref = () => safeMediaAttachmentHref(props.src);
  const card = (): AttachmentCardHeaderOptions => ({
    kind: "audio",
    label: props.label,
    mimeType: props.mimeType,
    sizeBytes: props.sizeBytes,
    downloadHref: downloadHref(),
    onExpand: props.onExpand,
    voiceNote: props.voiceNote,
  });
  const timeLabel = () =>
    `${formatChatMediaTime(view().currentTime)} / ${formatChatMediaTime(view().duration)}`;
  const Seek = () => {
    const waveformPeaks = createMemo(() => view().waveformPeaks);
    const waveformWidth = createMemo(() => view().waveformWidth);
    const displayedPeaks = createMemo(() =>
      resampleChatAudioWaveformPeaks(waveformPeaks(), waveformWidth()),
    );
    const Input = () => (
      <input
        class={[
          "chat-audio-player__seek",
          { "chat-audio-player__seek--waveform": Boolean(view().waveformPeaks) },
        ]}
        type="range"
        min="0"
        max={String(view().duration || 0)}
        step="0.01"
        value={String(Math.min(view().currentTime, view().duration || view().currentTime))}
        aria-label={t("chat.mediaPlayer.seek")}
        aria-valuetext={timeLabel()}
        style={{
          "--chat-audio-progress": `${progress() * 100}%`,
          "--chat-audio-buffered": `${Math.max(progress(), view().buffered) * 100}%`,
        }}
        onInput={(event) => seekTo(Number(event.currentTarget.value))}
      />
    );
    const Waveform = () => {
      onCleanup(() => {
        waveformResizeObserver?.disconnect();
        waveformResizeObserver = null;
        waveformElement = null;
      });
      return (
        <div class="chat-audio-player__waveform" ref={setWaveform}>
          <svg
            viewBox={`0 0 ${displayedPeaks().length} 24`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <For each={displayedPeaks()} keyed={false}>
              {(peak, index) => {
                // Voice notes retain measured relative peaks in a calmer visual range.
                const height = () => (props.voiceNote ? 6 + peak() * 8 : Math.max(2, peak() * 20));
                return (
                  <rect
                    class={index / displayedPeaks().length < progress() ? "is-played" : ""}
                    x={String(index + 0.25)}
                    y={String((24 - height()) / 2)}
                    width="0.5"
                    height={String(height())}
                    rx="0.25"
                  />
                );
              }}
            </For>
          </svg>
          <Input />
        </div>
      );
    };
    return (
      <Show when={view().waveformPeaks} fallback={<Input />}>
        <Waveform />
      </Show>
    );
  };
  const Player = () => {
    onCleanup(() => {
      viewport.disconnect();
      waveformVisible = false;
      waveformController?.abort();
      waveformController = null;
      waveformAttempted = false;
      releaseWaveformBlob?.();
      releaseWaveformBlob = undefined;
      const media = mediaElement;
      mediaElement = null;
      if (media) {
        releaseChatAudioPlayback(media);
        // Clear the departed node while retaining unavailable readiness until the source changes.
        sourceController.reset(media);
      }
    });
    return (
      <div
        class={[
          "chat-assistant-attachment-card chat-assistant-attachment-card--audio",
          { "chat-assistant-attachment-card--voice-note": props.voiceNote },
        ]}
        ref={viewport.setElement}
        data-openable={!props.voiceNote && props.onExpand ? "" : undefined}
        onClick={(event) =>
          openAttachmentCardFromClick(event, props.voiceNote ? undefined : props.onExpand)
        }
      >
        <Show when={!props.voiceNote}>
          <LitContent
            render={() =>
              renderAttachmentCardHeader({ ...card(), visualMode: "preview-with-favicon" })
            }
          />
        </Show>
        <Show
          when={sourceState().readiness !== "preparing"}
          fallback={
            <div class="chat-assistant-attachment-card__reason chat-media-preparing">
              {t("chat.mediaPlayer.preparing")}
            </div>
          }
        >
          <div
            class="chat-audio-player"
            role="group"
            aria-label={props.voiceNote ? t("chat.messages.voiceNote") : props.label}
            tabindex="0"
            onKeyDown={handlePlayerKeydown}
          >
            <button
              type="button"
              class="chat-audio-player__toggle"
              disabled={props.playback === "transcode" && sourceState().readiness !== "ready"}
              aria-label={t(view().playing ? "chat.mediaPlayer.pause" : "chat.mediaPlayer.play")}
              onClick={togglePlayback}
            >
              <Icon name={view().playing ? "pause" : "play"} />
            </button>
            <div class="chat-audio-player__time" aria-live="off">
              <span>{timeLabel()}</span>
            </div>
            <div class="chat-audio-player__timeline">
              <Seek />
            </div>
            <button
              type="button"
              class="chat-audio-player__volume"
              aria-label={t(view().muted ? "chat.mediaPlayer.unmute" : "chat.mediaPlayer.mute")}
              onClick={toggleMuted}
            >
              <Icon name={view().muted ? "volumeX" : "volume2"} />
            </button>
          </div>
        </Show>
        <audio
          class="chat-audio-player__media"
          preload="metadata"
          ref={setMedia}
          onLoadedMetadata={() => {
            const media = mediaElement;
            if (!media) {
              return;
            }
            sourceController.handleLoadedMetadata(media, () => canResumeChatAudioPlayback(media));
            updateState({
              duration: Number.isFinite(media.duration) ? media.duration : 0,
              currentTime: media.currentTime,
            });
            updateBuffered();
            props.onMediaLoaded?.();
          }}
          onDurationChange={() => {
            if (mediaElement) {
              updateState({
                duration: Number.isFinite(mediaElement.duration) ? mediaElement.duration : 0,
              });
            }
          }}
          onTimeUpdate={() => {
            if (mediaElement) {
              updateState({ currentTime: mediaElement.currentTime });
              updateBuffered();
            }
          }}
          onProgress={updateBuffered}
          onPlay={() => {
            if (mediaElement) {
              claimChatAudioPlayback(mediaElement, cancelPendingResume);
              updateState({ playing: true });
            }
          }}
          onPause={() => mediaElement && updateState({ playing: false })}
          onEnded={() => {
            if (mediaElement) {
              releaseChatAudioPlayback(mediaElement);
              sourceController.handleEnded(mediaElement);
              updateState({ playing: false });
            }
          }}
          onError={() => {
            if (!mediaElement) {
              return;
            }
            if (!sourceController.handleError(mediaElement)) {
              releaseChatAudioPlayback(mediaElement);
              updateState({ playing: false });
            }
            publish();
          }}
        />
      </div>
    );
  };
  return (
    <Show
      when={sourceState().readiness !== "unavailable"}
      fallback={
        <Show
          when={props.voiceNote}
          fallback={<LitContent render={() => renderCompactAttachmentCard(card())} />}
        >
          <div class="chat-assistant-attachment-card chat-assistant-attachment-card--voice-note">
            <div class="chat-audio-player" role="group" aria-label={t("chat.messages.voiceNote")}>
              <span class="chat-assistant-attachment-card__reason" role="status">
                {t("chat.attachments.previewUnavailable")}
              </span>
              <Show when={downloadHref()}>
                <a
                  class="chat-assistant-attachment-card__action"
                  href={downloadHref()}
                  download={props.label}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("chat.mediaPlayer.download", { filename: props.label })}
                >
                  <Icon name="download" />
                </a>
              </Show>
            </div>
          </div>
        </Show>
      }
    >
      <Player />
    </Show>
  );
}

export const ChatAudioPlayer = defineSolidBridge(
  "openclaw-chat-audio-player",
  ChatAudioPlayerContent,
  {
    properties: {
      src: { default: "" },
      sourceIdentity: { default: "" },
      label: { default: "" },
      mimeType: { default: "" },
      playback: { default: "native" },
      authToken: { default: null },
      sizeBytes: { default: undefined, type: Number },
      serverDurationMs: { default: undefined, type: Number },
      voiceNote: { default: false },
      onExpand: { default: undefined, attribute: false },
      onMediaLoaded: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-audio-player": SolidBridgeElement<ChatAudioPlayerProps>;
  }
}
