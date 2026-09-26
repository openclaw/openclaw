import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { beginClipboardCopy } from "../../../lib/clipboard.ts";
import { showToast } from "../../../lib/toast.ts";

function imageDownloadFileName(title: string, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/", 2)[1] || "img";
  const rawStem = Array.from(title, (character) =>
    character.codePointAt(0)! <= 0x1f || '<>:"/\\|?*'.includes(character) ? "-" : character,
  )
    .join("")
    .replace(/\.[a-z0-9]{1,10}$/iu, "")
    .replace(/[. -]+$/u, "");
  const stem = truncateUtf16Safe(rawStem, 120);
  return `${stem || "generated-image"}.${/^[a-z0-9.+-]{1,12}$/u.test(extension) ? extension : "img"}`;
}

function downloadImageBlob(blob: Blob, fileName: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}

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

export function renderChatImageActions(title: string, readOriginalBlob: () => Promise<Blob>) {
  const download = async () => {
    try {
      const blob = await readOriginalBlob();
      downloadImageBlob(blob, imageDownloadFileName(title, blob.type));
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
      const png = readOriginalBlob().then(convertImageBlobToPng);
      void png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      showToast({ message: t("common.copied") });
    } catch {
      showToast({ message: t("chat.imageLightbox.copyFailed") });
    }
  };
  return html`
    <span class="chat-image-actions">
      ${(
        [
          ["chat.imageLightbox.download", icons.download, download],
          ["chat.imageLightbox.copy", icons.copy, copy],
        ] as const
      ).map(
        ([label, icon, action]) => html`
          <button
            type="button"
            class="chat-image-action"
            title=${t(label)}
            aria-label=${t(label)}
            @click=${() => void action()}
          >
            ${icon}
          </button>
        `,
      )}
    </span>
  `;
}
