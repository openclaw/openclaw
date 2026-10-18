import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { beginClipboardCopy } from "../../../lib/clipboard.ts";
import { downloadImageBlob } from "../../../lib/image-download.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";

let nextMenuId = 0;

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") {
    return blob;
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
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
    bitmap.close();
  }
}

export function ChatImageActions(props: { title: string; readOriginalBlob: () => Promise<Blob> }) {
  const download = async () => {
    try {
      const blob = await props.readOriginalBlob();
      downloadImageBlob(blob, props.title);
    } catch {
      showToast({ message: t("chat.imageLightbox.downloadFailed") });
    }
  };
  const copy = async () => {
    beginClipboardCopy();
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("image clipboard is unavailable");
      }
      const png = props.readOriginalBlob().then(convertImageBlobToPng);
      void png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      showToast({ message: t("common.copied") });
    } catch {
      showToast({ message: t("chat.imageLightbox.copyFailed") });
    }
  };
  const id = `chat-image-actions-${++nextMenuId}`;
  return (
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
  );
}
