import type { JSX } from "@solidjs/web";
import { Show, action, createOptimistic } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { showToast } from "../lib/toast.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import { Icon } from "./solid/icon.tsx";

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
  originalUrl: string;
  externalImageUrl: string;
  resolvingOriginal: boolean;
  isVideo: boolean;
  onDownloadImage: () => Promise<void>;
  onClose: (event?: Event) => void;
  children: JSX.Element;
}) {
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
      <Show when={!props.isVideo || props.originalUrl || props.resolvingOriginal}>
        <openclaw-modal-actions class="lightbox-footer">
          <Show
            when={props.isVideo}
            fallback={
              <LightboxImageDownload
                focusableRef={props.focusableRef}
                onDownload={props.onDownloadImage}
              />
            }
          >
            <a
              ref={props.focusableRef()}
              class="action open-original"
              href={props.originalUrl || undefined}
              aria-disabled={props.originalUrl ? "false" : "true"}
              tabindex={props.originalUrl ? 0 : -1}
              target="_blank"
              rel="noreferrer"
              aria-label={t("chat.imageLightbox.openOriginal")}
            >
              <span class="open-original-label">{t("chat.imageLightbox.openOriginal")}</span>
              <span class="open-original-icon" aria-hidden="true">
                <Icon name="externalLink" />
              </span>
            </a>
          </Show>
          <Show when={!props.isVideo && props.externalImageUrl}>
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
      </Show>
    </section>
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
    ? `width: min(${width}px, 100cqw, calc(100cqh * ${width / height}))`
    : undefined;
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
