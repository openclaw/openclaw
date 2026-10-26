import type { JSX } from "@solidjs/web";
import {
  Errored,
  Loading,
  Show,
  action,
  createMemo,
  createOptimistic,
  createUniqueId,
  omit,
} from "solid-js";
import { registerChatMediaEnglish } from "../i18n/locales/en-chat-media.ts";
import { t, registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { showToast } from "../lib/toast.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import { Icon } from "./solid/icon.tsx";

registerEnglishCatalog(registerChatMediaEnglish);

type FocusableRef = () => (element: HTMLElement) => void;

export function LightboxAction(props: {
  focusableRef: FocusableRef;
  class: string;
  label: string;
  disabled: boolean;
  action: () => unknown;
  children: JSX.Element;
}) {
  return (
    <button
      ref={props.focusableRef()}
      class={["action", props.class]}
      type="button"
      aria-label={t(props.label)}
      aria-disabled={props.disabled ? "true" : "false"}
      onClick={() => props.action()}
    >
      {props.children}
    </button>
  );
}

export function LightboxChrome(props: {
  focusableRef: FocusableRef;
  title: string;
  originalUrl: Promise<string>;
  externalImageUrl: string;
  hasGallery: boolean;
  isVideo: boolean;
  onDownloadImage: () => Promise<void>;
  onClose: (event?: Event) => void;
  children: JSX.Element;
}) {
  const originalUrl = createMemo(() => props.originalUrl);
  return (
    <section class="lightbox">
      <header class="header">
        <strong class="title">{props.title}</strong>
        <div class="actions">
          <button
            ref={props.focusableRef()}
            class="action close"
            type="button"
            autofocus
            aria-label={
              props.isVideo
                ? t("chat.mediaPlayer.closeVideoPreview")
                : t("chat.imageLightbox.close")
            }
            onClick={() => props.onClose()}
          >
            <Icon name="x" />
          </button>
        </div>
      </header>
      {props.children}
      <Show
        when={props.isVideo}
        fallback={
          <openclaw-modal-actions class="lightbox-footer">
            <LightboxImageDownload
              focusableRef={props.focusableRef}
              onDownload={props.onDownloadImage}
            />
            <Show when={props.externalImageUrl}>
              <a
                ref={props.focusableRef()}
                class="action external-image"
                href={props.externalImageUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={t("chat.imageLightbox.openOriginal")}
              >
                <Icon name="externalLink" />
              </a>
            </Show>
          </openclaw-modal-actions>
        }
      >
        {/* A failed original link must not hide the selected video or its controls. */}
        <Errored fallback={null}>
          <Loading
            on={props.originalUrl}
            fallback={
              <Show when={props.hasGallery}>
                <LightboxVideoOriginal focusableRef={props.focusableRef} url="" />
              </Show>
            }
          >
            <Show when={originalUrl()}>
              {(url) => <LightboxVideoOriginal focusableRef={props.focusableRef} url={url()} />}
            </Show>
          </Loading>
        </Errored>
      </Show>
    </section>
  );
}

export function LightboxImage(
  props: JSX.ImgHTMLAttributes<HTMLImageElement> & { description?: string },
) {
  const descriptionId = createUniqueId();
  const imageProps = omit(props, "description");
  return (
    <>
      <img {...imageProps} aria-describedby={props.description ? descriptionId : undefined} />
      <Show when={props.description}>
        <p id={descriptionId} hidden>
          {props.description}
        </p>
      </Show>
    </>
  );
}

function LightboxVideoOriginal(props: { focusableRef: FocusableRef; url: string }) {
  return (
    <openclaw-modal-actions class="lightbox-footer">
      <a
        ref={props.focusableRef()}
        class="action open-original"
        href={props.url || undefined}
        aria-disabled={props.url ? "false" : "true"}
        tabindex={props.url ? 0 : -1}
        target="_blank"
        rel="noreferrer"
        aria-label={t("chat.imageLightbox.openOriginal")}
      >
        <span class="open-original-label">{t("chat.imageLightbox.openOriginal")}</span>
        <span class="open-original-icon" aria-hidden="true">
          <Icon name="externalLink" />
        </span>
      </a>
    </openclaw-modal-actions>
  );
}

export function lightboxImageStyle(image: ImageLightboxItem | undefined) {
  const width = image?.width;
  const height = image?.height;
  return typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0
    ? { width: `min(${width}px, 100cqw, calc(100cqh * ${width / height}))` }
    : { width: undefined };
}

function LightboxImageDownload(props: {
  focusableRef: FocusableRef;
  onDownload: () => Promise<void>;
}) {
  const [downloading, setDownloading] = createOptimistic(false);
  const download = action(function* (button: HTMLButtonElement) {
    setDownloading(true);
    try {
      yield props.onDownload();
    } catch {
      // An action can outlive the view, including a reconnect of its host.
      if (button.isConnected) {
        showToast({ message: t("chat.imageLightbox.downloadFailed") });
      }
    }
  });
  return (
    <button
      ref={props.focusableRef()}
      class="action download-image"
      type="button"
      disabled={downloading()}
      aria-busy={downloading() ? "true" : undefined}
      aria-label={t("chat.imageLightbox.download")}
      onClick={(event) => {
        if (!downloading()) {
          void download(event.currentTarget);
        }
      }}
    >
      <Icon name="download" />
      <span>{downloading() ? t("common.loading") : t("chat.imageLightbox.download")}</span>
    </button>
  );
}
