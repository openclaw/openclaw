import type { JSX } from "@solidjs/web";
import { Show, createSignal, onCleanup, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { requestVideoPoster } from "../../../lib/media/video-poster.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";

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
  const [posterUrl, setPosterUrl] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);
  let controller: AbortController | undefined;
  let currentPoster: string | undefined;
  let visible = false;
  let disposed = false;
  let element!: HTMLDivElement;
  const release = () => {
    controller?.abort();
    controller = undefined;
    if (currentPoster) {
      URL.revokeObjectURL(currentPoster);
    }
    currentPoster = undefined;
    setPosterUrl(undefined);
  };
  const requestPoster = () => {
    if (disposed || !visible || controller || failed()) {
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
      if (disposed || request !== controller || request.signal.aborted || !visible) {
        return;
      }
      if (blob) {
        currentPoster = URL.createObjectURL(blob);
        setPosterUrl(currentPoster);
      } else {
        setFailed(true);
      }
    });
  };
  onSettled(() =>
    observeChatAttachmentViewport(
      element,
      () => {
        visible = true;
        requestPoster();
      },
      () => {
        visible = false;
        release();
      },
    ),
  );
  onCleanup(() => {
    disposed = true;
    release();
  });
  return (
    <div
      class="chat-video-preview__content"
      ref={(value) => {
        element = value;
      }}
    >
      <Show when={!failed()} fallback={props.fallback}>
        <button
          type="button"
          class="chat-message-image-button"
          aria-label={`${t("chat.attachments.open")}: ${props.label}`}
          onClick={() => props.onOpen()}
        >
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
                  if (!disposed && currentPoster === url()) {
                    release();
                    setFailed(true);
                  }
                }}
              />
            )}
          </Show>
          <span class="chat-video-preview__play" aria-hidden="true">
            <Icon name="play" />
          </span>
        </button>
      </Show>
    </div>
  );
}
