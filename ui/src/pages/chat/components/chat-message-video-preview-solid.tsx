import type { JSX } from "@solidjs/web";
import { Show, createSignal, onSettled, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { requestVideoPoster } from "../../../lib/media/video-poster.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export type VideoPreviewProps = {
  key: string;
  src: string;
  label: string;
  onOpen: () => void;
  fallback: JSX.Element;
};

export function MessageVideoPreview(props: VideoPreviewProps): JSX.Element {
  return (
    <Show when={props.key} keyed>
      {(_key) => <VideoPreviewContent {...props} />}
    </Show>
  );
}

function VideoPreviewContent(props: VideoPreviewProps): JSX.Element {
  const presented = useContext(ContentPresentation);
  const [failed, setFailed] = createSignal(false);
  let button!: HTMLButtonElement;
  return (
    <div class="chat-video-preview__content">
      <Show when={!failed()} fallback={props.fallback}>
        <button
          ref={(element) => {
            button = element;
          }}
          type="button"
          class="chat-message-image-button"
          aria-label={`${t("chat.attachments.open")}: ${props.label}`}
          onClick={() => props.onOpen()}
        >
          <Show
            when={presented()}
            fallback={<span class="chat-message-image chat-video-preview__placeholder" />}
          >
            <VideoPoster
              key={props.key}
              src={props.src}
              label={props.label}
              getTarget={() => button}
              onFailed={() => setFailed(true)}
            />
          </Show>
          <span class="chat-video-preview__play" aria-hidden="true">
            <Icon name="play" />
          </span>
        </button>
      </Show>
    </div>
  );
}

function VideoPoster(props: {
  key: string;
  src: string;
  label: string;
  getTarget: () => HTMLElement;
  onFailed: () => void;
}): JSX.Element {
  const [posterUrl, setPosterUrl] = createSignal<string>();
  let active = true;
  let controller: AbortController | undefined;
  let currentPoster: string | undefined;
  const release = () => {
    controller?.abort();
    controller = undefined;
    if (currentPoster) {
      URL.revokeObjectURL(currentPoster);
    }
    currentPoster = undefined;
  };
  const requestPoster = () => {
    if (!active || controller) {
      return;
    }
    const request = new AbortController();
    controller = request;
    void requestVideoPoster({
      key: props.key,
      src: props.src,
      width: 400,
      height: 225,
      signal: request.signal,
    }).then((blob) => {
      // Hiding, parking, or disposal aborts this request through release().
      if (request.signal.aborted) {
        return;
      }
      if (blob) {
        currentPoster = URL.createObjectURL(blob);
        setPosterUrl(currentPoster);
      } else {
        props.onFailed();
      }
    });
  };
  onSettled(() => {
    const stopObserving = observeChatAttachmentViewport(props.getTarget(), requestPoster, () => {
      if (active) {
        release();
        setPosterUrl(undefined);
      }
    });
    return () => {
      active = false;
      stopObserving();
      release();
    };
  });
  return (
    <Show
      when={posterUrl()}
      fallback={<span class="chat-message-image chat-video-preview__placeholder" />}
    >
      {(url) => (
        <img
          class="chat-message-image"
          src={url()}
          alt={props.label}
          onError={() => {
            release();
            props.onFailed();
          }}
        />
      )}
    </Show>
  );
}
