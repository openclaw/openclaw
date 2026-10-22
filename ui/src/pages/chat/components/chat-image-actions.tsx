import { Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { beginClipboardCopy } from "../../../lib/clipboard.ts";
import { downloadImageBlob } from "../../../lib/image-download.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";

let nextMenuId = 0;

export async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") {
    return blob;
  }
  // SVG is decoded in image context, never executed as a document. The lightbox
  // and clipboard receive raster bytes; the separate file download keeps the original.
  const svg = blob.type.split(";", 1)[0] === "image/svg+xml";
  const url = svg ? URL.createObjectURL(blob) : undefined;
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    if (url) {
      const image = new Image();
      image.src = url;
      await image.decode();
      bitmap = image;
    } else {
      bitmap = await createImageBitmap(blob);
    }
  } catch (error) {
    if (url) {
      URL.revokeObjectURL(url);
    }
    throw error;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap instanceof HTMLImageElement ? bitmap.naturalWidth : bitmap.width;
    canvas.height = bitmap instanceof HTMLImageElement ? bitmap.naturalHeight : bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("image conversion context is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (converted) =>
          converted ? resolve(converted) : reject(new Error("image conversion failed")),
        "image/png",
      );
    });
  } finally {
    if (bitmap instanceof ImageBitmap) {
      bitmap.close();
    }
    if (url) {
      URL.revokeObjectURL(url);
    }
  }
}

export async function copyImageToClipboard(readBlob: () => Promise<Blob>): Promise<void> {
  beginClipboardCopy();
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("image clipboard is unavailable");
  }
  const png = readBlob().then(convertImageBlobToPng);
  void png.catch(() => {});
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export function ChatImageActions(props: {
  title: string;
  readOriginalBlob: () => Promise<Blob>;
  overlay?: boolean;
}) {
  const download = async () => {
    try {
      const blob = await props.readOriginalBlob();
      downloadImageBlob(blob, props.title);
    } catch {
      showToast({ message: t("chat.imageLightbox.downloadFailed") });
    }
  };
  const copy = async () => {
    try {
      await copyImageToClipboard(props.readOriginalBlob);
      showToast({ message: t("common.copied") });
    } catch {
      showToast({ message: t("chat.imageLightbox.copyFailed") });
    }
  };
  const id = `chat-image-actions-${++nextMenuId}`;
  return (
    <Show
      when={props.overlay}
      fallback={
        <Menu
          id={id}
          class="chat-image-actions"
          triggerClass="chat-image-action"
          placement="bottom-end"
          label={t("chat.imageLightbox.actions")}
          triggerAttributes={{ title: t("chat.imageLightbox.actions") }}
          trigger={<Icon name="moreHorizontal" />}
          items={[
            {
              id: "copy",
              label: t("chat.imageLightbox.copy"),
              class: "session-menu__item",
              icon: (
                <span class="session-menu__icon">
                  <Icon name="copy" />
                </span>
              ),
              content: <span class="session-menu__text">{t("chat.imageLightbox.copy")}</span>,
            },
            {
              id: "download",
              label: t("chat.imageLightbox.download"),
              class: "session-menu__item",
              icon: (
                <span class="session-menu__icon">
                  <Icon name="download" />
                </span>
              ),
              content: <span class="session-menu__text">{t("chat.imageLightbox.download")}</span>,
            },
          ]}
          onSelect={(item) => {
            void (item.id === "copy" ? copy() : download());
          }}
        />
      }
    >
      <span class="chat-image-actions chat-image-actions--overlay">
        <button
          type="button"
          class="chat-image-action"
          title={t("chat.imageLightbox.download")}
          aria-label={t("chat.imageLightbox.download")}
          onClick={() => void download()}
        >
          <Icon name="download" />
        </button>
        <button
          type="button"
          class="chat-image-action"
          title={t("chat.imageLightbox.copy")}
          aria-label={t("chat.imageLightbox.copy")}
          onClick={() => void copy()}
        >
          <Icon name="copy" />
        </button>
      </span>
    </Show>
  );
}
