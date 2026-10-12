import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { YouTubeVideo } from "../../../lib/chat/youtube-video.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import "./youtube-video-card.css";

type YouTubeVideoProps = { video?: YouTubeVideo; videoTitle: string; enabled: boolean };
const activePlayers = new WeakMap<Document, () => void>();

function YouTubeVideoContent(
  props: YouTubeVideoProps,
  host: SolidBridgeElement<YouTubeVideoProps>,
) {
  const [playing, setPlaying] = createSignal(false);
  const [thumbnailFailed, setThumbnailFailed] = createSignal(false);
  const [wideEnough, setWideEnough] = createSignal(true);
  const canPlay = () => props.enabled && wideEnough();
  const title = () => props.videoTitle.trim() || t("chat.youtube.video");
  const sourceUrl = createMemo(() => props.video?.watchUrl);
  const playerUrl = createMemo(() => {
    if (!props.video) {
      return undefined;
    }
    const url = new URL(props.video.embedUrl);
    url.searchParams.set("autoplay", "1");
    return url.href;
  });
  const releasePlayback = () => {
    if (activePlayers.get(host.ownerDocument) === stopPlayback) {
      activePlayers.delete(host.ownerDocument);
    }
  };
  const stopPlayback = () => {
    releasePlayback();
    setPlaying(false);
  };
  const startPlayback = () => {
    activePlayers.get(host.ownerDocument)?.();
    activePlayers.set(host.ownerDocument, stopPlayback);
    setPlaying(true);
  };
  createEffect(sourceUrl, () => {
    stopPlayback();
    setThumbnailFailed(false);
  });
  createEffect(canPlay, (enabled) => {
    if (!enabled) {
      stopPlayback();
    }
  });
  onSettled(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        // YouTube requires a player viewport of at least 200 × 200 CSS pixels.
        setWideEnough(entry.contentRect.width >= 200);
      }
    });
    observer.observe(host);
    return () => observer.disconnect();
  });
  onCleanup(releasePlayback);
  const PreviewContents = () => (
    <>
      <Show when={!thumbnailFailed()}>
        <img
          src={props.video?.thumbnailUrl}
          alt=""
          loading="lazy"
          referrerpolicy="no-referrer"
          onError={() => setThumbnailFailed(true)}
        />
      </Show>
      <span class="play" aria-hidden="true">
        <Icon name={canPlay() ? "play" : "externalLink"} />
      </span>
    </>
  );
  return (
    <Show when={props.video}>
      <section class="card" aria-label={title()}>
        <div class="stage">
          <Show
            when={playing() && canPlay()}
            fallback={
              <Show
                when={canPlay()}
                fallback={
                  <a
                    class="preview"
                    href={props.video?.watchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("chat.youtube.openVideo", { title: title() })}
                  >
                    <PreviewContents />
                  </a>
                }
              >
                <button
                  class="preview"
                  type="button"
                  aria-label={t("chat.youtube.play", { title: title() })}
                  onClick={startPlayback}
                >
                  <PreviewContents />
                </button>
              </Show>
            }
          >
            <iframe
              src={playerUrl()}
              title={t("chat.youtube.player", { title: title() })}
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
              allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
              allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"
            />
          </Show>
        </div>
        <div class="footer">
          <div class="caption">
            <span class="provider">{t("chat.youtube.provider")}</span>
            <p class="title">{title()}</p>
          </div>
          <a class="watch" href={props.video?.watchUrl} target="_blank" rel="noopener noreferrer">
            {t("chat.youtube.open")}
            <Icon name="externalLink" />
          </a>
          <Show when={playing()}>
            <button
              class="close"
              type="button"
              aria-label={t("chat.youtube.close")}
              onClick={() => {
                stopPlayback();
                queueMicrotask(() =>
                  host.querySelector<HTMLButtonElement>("button.preview")?.focus(),
                );
              }}
            >
              <Icon name="x" />
            </button>
          </Show>
        </div>
        <Show when={!canPlay()}>
          <p class="notice" role="status">
            {t(!props.enabled ? "chat.youtube.strict" : "chat.youtube.narrow")}
          </p>
        </Show>
      </section>
    </Show>
  );
}

export const YouTubeVideoCard = defineSolidBridge("openclaw-youtube-video", YouTubeVideoContent, {
  properties: {
    video: { default: undefined, attribute: false },
    videoTitle: { default: "" },
    enabled: { default: true },
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-youtube-video": SolidBridgeElement<YouTubeVideoProps>;
  }
}
