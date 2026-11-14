import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { downloadBlobFile } from "./download.ts";

function imageDownloadFileName(title: string, mimeType: string): string {
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension =
    type === "image/svg+xml"
      ? "svg"
      : type === "image/jpeg"
        ? "jpg"
        : type.split("/", 2)[1] || "img";
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
  // SVG originals are files, not active documents in the app origin.
  const payload =
    blob.type.split(";", 1)[0]?.trim().toLowerCase() === "image/svg+xml"
      ? new Blob([blob], { type: "application/octet-stream" })
      : blob;
  downloadBlobFile(imageDownloadFileName(title, blob.type), payload, 30_000);
}
