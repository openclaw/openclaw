import type { JSX } from "@solidjs/web";
import { Show, createSignal, onCleanup } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { showToast } from "../lib/toast.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";
import { Icon } from "./solid/icon.tsx";

export function LightboxAction(props: {
  class: string;
  label: string;
  disabled: boolean;
  action: () => unknown;
  children: JSX.Element;
}) {
  return (
    <button
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
      <LightboxHeader title={props.title} isVideo={props.isVideo} onClose={props.onClose} />
      {props.children}
      <LightboxFooter
        originalUrl={props.originalUrl}
        externalImageUrl={props.externalImageUrl}
        resolvingOriginal={props.resolvingOriginal}
        isVideo={props.isVideo}
        onDownloadImage={props.onDownloadImage}
      />
    </section>
  );
}

function LightboxHeader(props: {
  title: string;
  isVideo: boolean;
  onClose: (event?: Event) => void;
}) {
  return (
    <header class="header">
      <strong class="title">{props.title}</strong>
      <div class="actions">
        <button
          class="action close"
          type="button"
          autofocus
          aria-label={
            props.isVideo ? t("chat.mediaPlayer.closeVideoPreview") : t("chat.imageLightbox.close")
          }
          onClick={() => props.onClose()}
        >
          <Icon name="x" />
        </button>
      </div>
    </header>
  );
}

function LightboxFooter(props: {
  originalUrl: string;
  externalImageUrl: string;
  resolvingOriginal: boolean;
  isVideo: boolean;
  onDownloadImage: () => Promise<void>;
}) {
  return (
    <Show when={!props.isVideo || props.originalUrl || props.resolvingOriginal}>
      <openclaw-modal-actions class="lightbox-footer">
        <Show
          when={props.isVideo}
          fallback={<LightboxImageDownload onDownload={props.onDownloadImage} />}
        >
          <a
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

export function LightboxImageQualityStatus(props: {
  upgrading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <Show when={props.upgrading || props.failed}>
      <div class="image-quality-status" role="status" aria-live="polite">
        <span>
          {props.upgrading
            ? t("chat.imageLightbox.loadingDetail")
            : t("chat.imageLightbox.detailFailed")}
        </span>
        <Show when={props.failed}>
          <button type="button" class="action" onClick={() => props.onRetry()}>
            {t("common.retry")}
          </button>
        </Show>
      </div>
    </Show>
  );
}

function LightboxImageDownload(props: { onDownload: () => Promise<void> }) {
  const [downloading, setDownloading] = createSignal(false, { ownedWrite: true });
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const download = async () => {
    if (downloading()) {
      return;
    }
    setDownloading(true);
    try {
      await props.onDownload();
    } catch {
      if (active) {
        showToast({ message: t("chat.imageLightbox.downloadFailed") });
      }
    } finally {
      if (active) {
        setDownloading(false);
      }
    }
  };
  return (
    <button
      class="action download-image"
      type="button"
      disabled={downloading()}
      aria-busy={downloading() ? "true" : undefined}
      aria-label={t("chat.imageLightbox.download")}
      onClick={() => {
        void download();
      }}
    >
      <Icon name="download" />
      <span>{downloading() ? t("common.loading") : t("chat.imageLightbox.download")}</span>
    </button>
  );
}
