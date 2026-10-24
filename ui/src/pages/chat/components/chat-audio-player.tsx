import { createMemo, createStore, For, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerChatMediaEnglish } from "../../../i18n/locales/en-chat-media.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import { defineSolidBridge } from "../../../lib/solid-bridge.ts";
import { AttachmentCardHeader, CompactAttachmentCard } from "./chat-attachment-card-solid.tsx";
import {
  openAttachmentCardFromClick,
  type AttachmentCardHeaderOptions,
} from "./chat-attachment-card.ts";
import { attachmentContextCopyRef } from "./chat-attachment-context-copy.ts";
import { safeMediaAttachmentHref } from "./chat-attachment-href.ts";
import { createChatAttachmentViewportRef } from "./chat-attachment-viewport.ts";
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
import { ChatMediaSourceOwner } from "./chat-media-source.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

registerEnglishCatalog(registerChatComposerEnglish);

registerEnglishCatalog(registerChatMediaEnglish);

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

const inputHandlers = new WeakMap<HTMLElement, (key: keyof ChatAudioPlayerProps) => void>();

function ChatAudioPlayerContent(
  props: ChatAudioPlayerProps,
  host: SolidBridgeElement<ChatAudioPlayerProps>,
) {
  host.style.display = "contents";
  const [state, setState] = createStore<
    Record<"currentTime" | "duration" | "buffered" | "waveformWidth", number> & {
      playing: boolean;
      muted: boolean;
      waveformPeaks: readonly number[] | null;
    }
  >({
    currentTime: 0,
    duration: 0,
    buffered: 0,
    playing: false,
    muted: false,
    waveformPeaks: null,
    waveformWidth: 0,
  });
  const sourceController = new ChatMediaSourceOwner();
  const sourceState = projectOwner(sourceController, (owner) => owner);
  const cancelPendingResume = () => sourceController.cancelPendingResume();
  let mediaElement: HTMLAudioElement | null = null;
  let fallbackDownload: HTMLAnchorElement | undefined;
  const setFallbackDownload = (element: HTMLAnchorElement) => (fallbackDownload = element);
  let releaseWaveformBlob: (() => void) | undefined;
  let waveformController: AbortController | null = null;
  let waveformAttempted = false;
  let waveformVisible = false;
  let active = true;
  function handleInputsChanged(key: keyof ChatAudioPlayerProps): void {
    if (key === "sizeBytes" || key === "serverDurationMs") {
      sourceController.queueSync(syncSource);
      return;
    }
    if (key !== "src" && key !== "sourceIdentity" && key !== "playback" && key !== "authToken") {
      return;
    }
    if (sourceController.readiness === "unavailable") {
      releaseWaveformBlob?.();
      releaseWaveformBlob = undefined;
      sourceController.cancel();
    }
    if (key !== "src") {
      if (key !== "playback") {
        sourceController.cancel();
      }
      waveformController?.abort();
      waveformController = null;
      releaseWaveformBlob?.();
      releaseWaveformBlob = undefined;
      waveformAttempted = false;
      setState((draft) =>
        Object.assign(draft, { waveformPeaks: null, currentTime: 0, duration: 0, buffered: 0 }),
      );
      if (mediaElement && !mediaElement.paused) {
        mediaElement.pause();
        releaseChatAudioPlayback(mediaElement);
      }
    }
    sourceController.queueSync(syncSource);
  }
  onSettled(() => {
    inputHandlers.set(host, handleInputsChanged);
    const stopFocusRecovery = sourceState.subscribe(() => {
      if (sourceController.readiness !== "unavailable") {
        return;
      }
      const document = host.ownerDocument;
      const focused = document.activeElement;
      if (!host.contains(focused)) {
        return;
      }
      // Media errors and failed preparation both replace the focused player.
      onSettled(() => {
        if (
          host.isConnected &&
          fallbackDownload?.isConnected &&
          sourceController.readiness === "unavailable" &&
          (document.activeElement === focused || document.activeElement === document.body)
        ) {
          fallbackDownload.focus({ preventScroll: true });
        }
      });
    });
    syncSource();
    return () => {
      active = false;
      stopFocusRecovery();
      inputHandlers.delete(host);
      sourceState.dispose();
      sourceController.cancel();
    };
  });

  const setMedia = (element: HTMLAudioElement) => {
    mediaElement = element;
    syncSource();
  };

  function updateWaveformWidth(width: number): void {
    const nextWidth = Math.max(0, width);
    setState((draft) => {
      if (Math.abs(nextWidth - draft.waveformWidth) >= 0.5) {
        draft.waveformWidth = nextWidth;
      }
    });
  }

  function syncSource(): void {
    const media = mediaElement;
    if (!media || !active || !host.isConnected || releaseWaveformBlob) {
      return;
    }
    // The bridge holds current synchronous inputs for ref, event, and async callbacks.
    const pending = sourceController.sync(
      media,
      host.src,
      host.sourceIdentity,
      host.playback,
      host.authToken,
    );
    if (!pending && waveformVisible) {
      void prepareWaveformAudio().catch(() => undefined);
    }
    void pending?.then(() => {
      if (active && host.isConnected && waveformVisible) {
        void prepareWaveformAudio().catch(() => undefined);
      }
    });
  }

  function resolveWaveformCacheKey(): string {
    return [
      host.sourceIdentity.trim(),
      host.playback,
      host.src.trim(),
      host.authToken?.trim() ?? "",
    ].join("\0");
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
    setState((draft) => {
      draft.waveformPeaks = prepared.value.peaks?.length ? prepared.value.peaks : null;
      if (prepared.value.durationSeconds !== undefined) {
        draft.duration = prepared.value.durationSeconds;
      }
    });
    sourceController.updateSource(media, prepared.value.blobUrl, host.sourceIdentity);
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
    const { serverDurationMs, sizeBytes, authToken } = host;
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
      // Invoke play in the click task so strict browser media policies retain user activation.
      const playback = media.play();
      const failed = () => {
        releaseChatAudioPlayback(media);
        setState((draft) => Object.assign(draft, { playing: false }));
      };
      void playback.then(() => prepareWaveformAudio().catch(() => undefined)).catch(failed);
    } else {
      media.pause();
    }
  }

  function seekTo(nextTime: number): void {
    const media = mediaElement;
    if (!media) {
      return;
    }
    const duration = Number.isFinite(media.duration) ? media.duration : state.duration;
    if (sourceController.seek(media, Math.min(nextTime, duration || nextTime))) {
      setState((draft) => Object.assign(draft, { currentTime: media.currentTime }));
    }
  }

  function toggleMuted(): void {
    const muted = !(mediaElement?.muted ?? state.muted);
    if (mediaElement) {
      mediaElement.muted = muted;
    }
    setState((draft) => Object.assign(draft, { muted }));
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
      seekTo((mediaElement?.currentTime ?? 0) + direction * SEEK_STEP_SECONDS);
    }
  }

  function updateBuffered(media: HTMLAudioElement, duration = state.duration): void {
    setState((draft) => {
      draft.buffered =
        duration && media.buffered.length
          ? Math.min(1, media.buffered.end(media.buffered.length - 1) / duration)
          : 0;
    });
  }

  const progress = () => (state.duration > 0 ? Math.min(1, state.currentTime / state.duration) : 0);
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
    `${formatChatMediaTime(state.currentTime)} / ${formatChatMediaTime(state.duration)}`;
  const Seek = () => {
    const displayedPeaks = createMemo(() =>
      resampleChatAudioWaveformPeaks(state.waveformPeaks, state.waveformWidth),
    );
    const Input = () => (
      <input
        class={[
          "chat-audio-player__seek",
          { "chat-audio-player__seek--waveform": Boolean(state.waveformPeaks) },
        ]}
        type="range"
        min="0"
        max={String(state.duration || 0)}
        step="0.01"
        value={String(Math.min(state.currentTime, state.duration || state.currentTime))}
        aria-label={t("chat.mediaPlayer.seek")}
        aria-valuetext={timeLabel()}
        style={{
          "--chat-audio-progress": `${progress() * 100}%`,
          "--chat-audio-buffered": `${Math.max(progress(), state.buffered) * 100}%`,
        }}
        onInput={(event) => seekTo(Number(event.currentTarget.value))}
      />
    );
    const Waveform = () => {
      const waveformRef = elementRef((waveform: HTMLDivElement) => {
        updateWaveformWidth(waveform.getBoundingClientRect().width);
        if (typeof ResizeObserver === "undefined") {
          return undefined;
        }
        let current: HTMLDivElement | null = waveform;
        const observer = new ResizeObserver(([entry]) => {
          if (entry && current === entry.target) {
            updateWaveformWidth(entry.contentRect.width);
          }
        });
        observer.observe(waveform);
        return () => {
          observer.disconnect();
          current = null;
        };
      });
      return (
        <div class="chat-audio-player__waveform" ref={[waveformRef]}>
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
                    class={{ "is-played": index / displayedPeaks().length < progress() }}
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
      <Show when={state.waveformPeaks} fallback={<Input />}>
        <Waveform />
      </Show>
    );
  };
  const Player = () => {
    const copyRef = attachmentContextCopyRef(() =>
      props.voiceNote ? null : { name: props.label, href: downloadHref() },
    );
    const viewport = createChatAttachmentViewportRef(() => {
      waveformVisible = true;
      void prepareWaveformAudio().catch(() => undefined);
    });
    const playerRef = elementRef<HTMLDivElement>(() => () => {
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
        ref={[viewport, copyRef, playerRef]}
        data-openable={!props.voiceNote && props.onExpand ? "" : undefined}
        onClick={(event) =>
          openAttachmentCardFromClick(event, props.voiceNote ? undefined : props.onExpand)
        }
      >
        <Show when={!props.voiceNote}>
          <AttachmentCardHeader {...card()} visualMode="preview-with-favicon" />
        </Show>
        <Show
          when={sourceState.read().readiness !== "preparing"}
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
              disabled={props.playback === "transcode" && sourceState.read().readiness !== "ready"}
              aria-label={t(state.playing ? "chat.mediaPlayer.pause" : "chat.mediaPlayer.play")}
              onClick={togglePlayback}
            >
              <Icon name={state.playing ? "pause" : "play"} />
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
              aria-label={t(state.muted ? "chat.mediaPlayer.unmute" : "chat.mediaPlayer.mute")}
              onClick={toggleMuted}
            >
              <Icon name={state.muted ? "volumeX" : "volume2"} />
            </button>
          </div>
        </Show>
        <audio
          class="chat-audio-player__media"
          preload="metadata"
          muted={state.muted}
          ref={setMedia}
          onLoadedMetadata={(event) => {
            const media = event.currentTarget;
            sourceController.handleLoadedMetadata(media, () => canResumeChatAudioPlayback(media));
            const duration = Number.isFinite(media.duration) ? media.duration : 0;
            setState((draft) => {
              draft.duration = duration;
              draft.currentTime = media.currentTime;
            });
            updateBuffered(media, duration);
            props.onMediaLoaded?.();
          }}
          onDurationChange={(event) => {
            const media = event.currentTarget;
            setState((draft) => {
              draft.duration = Number.isFinite(media.duration) ? media.duration : 0;
            });
          }}
          onTimeUpdate={(event) => {
            const currentTime = event.currentTarget.currentTime;
            setState((draft) => Object.assign(draft, { currentTime }));
            updateBuffered(event.currentTarget);
          }}
          onProgress={(event) => updateBuffered(event.currentTarget)}
          onPlay={(event) => {
            claimChatAudioPlayback(event.currentTarget, cancelPendingResume);
            setState((draft) => Object.assign(draft, { playing: true }));
          }}
          onPause={() => setState((draft) => Object.assign(draft, { playing: false }))}
          onEnded={(event) => {
            releaseChatAudioPlayback(event.currentTarget);
            sourceController.handleEnded(event.currentTarget);
            setState((draft) => Object.assign(draft, { playing: false }));
          }}
          onError={(event) => {
            if (!sourceController.handleError(event.currentTarget)) {
              releaseChatAudioPlayback(event.currentTarget);
              setState((draft) => Object.assign(draft, { playing: false }));
            }
          }}
        />
      </div>
    );
  };
  return (
    <>
      <Show when={!props.voiceNote}>
        <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {sourceState.read().readiness === "unavailable"
            ? `${props.label}: ${t("chat.attachments.previewUnavailable")}`
            : ""}
        </span>
      </Show>
      <Show
        when={sourceState.read().readiness !== "unavailable"}
        fallback={
          <Show
            when={props.voiceNote}
            fallback={<CompactAttachmentCard {...card()} downloadRef={setFallbackDownload} />}
          >
            <div class="chat-assistant-attachment-card chat-assistant-attachment-card--voice-note">
              <div class="chat-audio-player" role="group" aria-label={t("chat.messages.voiceNote")}>
                <span class="chat-assistant-attachment-card__reason" role="status">
                  {t("chat.attachments.previewUnavailable")}
                </span>
                <Show when={downloadHref()}>
                  <a
                    class="chat-assistant-attachment-card__action"
                    ref={setFallbackDownload}
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
    </>
  );
}

defineSolidBridge("openclaw-chat-audio-player", ChatAudioPlayerContent, {
  propertyChanged: (host, key) => inputHandlers.get(host)?.(key),
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
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-audio-player": SolidBridgeElement<ChatAudioPlayerProps>;
  }
}
