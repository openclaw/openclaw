import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

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

export function downloadImageBlob(blob: Blob, title: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = imageDownloadFileName(title, blob.type);
  anchor.click();
  globalThis.setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
}
