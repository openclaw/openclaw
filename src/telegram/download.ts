import { t } from "../i18n/index.js";
import { detectMime } from "../media/mime.js";
import { type SavedMedia, saveMediaBuffer } from "../media/store.js";

export type TelegramFileInfo = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

export async function getTelegramFile(
  token: string,
  fileId: string,
  timeoutMs = 30_000,
): Promise<TelegramFileInfo> {
  const res = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  if (!res.ok) {
    throw new Error(t("telegram.errors.get_file_failed", { status: res.status, statusText: res.statusText }));
  }
  const json = (await res.json()) as { ok: boolean; result?: TelegramFileInfo };
  if (!json.ok || !json.result?.file_path) {
    throw new Error(t("telegram.errors.get_file_no_path"));
  }
  return json.result;
}

export async function downloadTelegramFile(
  token: string,
  info: TelegramFileInfo,
  maxBytes?: number,
  timeoutMs = 60_000,
): Promise<SavedMedia> {
  if (!info.file_path) {
    throw new Error(t("telegram.errors.file_path_missing"));
  }
  const url = `https://api.telegram.org/file/bot${token}/${info.file_path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) {
    throw new Error(t("telegram.errors.download_failed", { status: res.status }));
  }
  const array = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer: array,
    headerMime: res.headers.get("content-type"),
    filePath: info.file_path,
  });
  // save with inbound subdir
  const saved = await saveMediaBuffer(array, mime, "inbound", maxBytes, info.file_path);
  // Ensure extension matches mime if possible
  if (!saved.contentType && mime) {
    saved.contentType = mime;
  }
  return saved;
}
