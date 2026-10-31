import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { downloadBlobFile } from "./download.ts";

function imageDownloadFileName(title: string, mimeType: string): string {
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = type === "image/jpeg" ? "jpg" : type.split("/", 2)[1] || "img";
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
  downloadBlobFile(imageDownloadFileName(title, blob.type), blob, 30_000);
}
