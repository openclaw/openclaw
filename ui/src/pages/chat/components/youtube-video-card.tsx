import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import type { YouTubeVideo } from "../../../lib/chat/youtube-video.ts";
import "./youtube-video-card.css";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { observeResize } from "../../../lib/reactive/observers.ts";

registerEnglishCatalog(registerChatSessionEnglish);

type YouTubeVideoProps = { video?: YouTubeVideo; videoTitle: string; enabled: boolean };
const activePlayers = new WeakMap<Document, () => void>();

export function YouTubeVideoCard(props: YouTubeVideoProps) {
  let host!: HTMLElement;
  const [wideEnough, setWideEnough] = createSignal(true);
  const canPlay = createMemo(() => props.enabled && wideEnough());
  const title = () => props.videoTitle.trim() || t("chat.youtube.video");
  const sourceUrl = createMemo(() => props.video?.watchUrl);
  // Source and eligibility changes end playback; a restored policy never auto-plays.
  const [playing, setPlaying] = createSignal(() => {
    sourceUrl();
    canPlay();
    return false;
  });
  const [thumbnailFailed, setThumbnailFailed] = createSignal(() => {
    sourceUrl();
    return false;
  });
  let previewButton: HTMLButtonElement | undefined;
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
  onSettled(() => {
    const stopResize = observeResize([host], ([entry]) => {
      if (entry) {
        // YouTube requires a player viewport of at least 200 × 200 CSS pixels.
        setWideEnough(entry.contentRect.width >= 200);
      }
    });
    return () => {
      stopResize();
      releasePlayback();
    };
  });
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
    <openclaw-youtube-video ref={(element) => (host = element)}>
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
                    ref={(element) => {
                      previewButton = element;
                    }}
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
                  onSettled(() => previewButton?.focus());
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
    </openclaw-youtube-video>
  );
}
