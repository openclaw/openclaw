import { ARTIFACT_DOWNLOAD_PATH } from "../../../../packages/gateway-protocol/src/artifact-download.ts";
import * as json from "../snapshot-json.ts";
import { readChatThreadMessageIdentity } from "./history-message-identity.ts";
import { removePairingQrContent } from "./pairing-qr.ts";

export const MAX_CHAT_THUMBNAILS = 32;
export const MAX_CHAT_THUMBNAIL_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_THUMBNAIL_SIZE = 256 * 1024;

export function isChatThumbnail(value: Blob | undefined): value is Blob {
  return Boolean(
    value?.size &&
    value.size <= MAX_CHAT_THUMBNAIL_SIZE &&
    /^(?:image\/png|image\/jpeg|image\/webp|image\/avif)$/u.test(value.type),
  );
}

const text = json.refine(json.text, (value) => value.length <= 256);
const dimension = json.refine(
  json.number,
  (value) => Number.isInteger(value) && value > 0 && value <= 100_000,
);
const boundedRecord = <T>(reader: json.SnapshotReader<T>, max: number, keyLength = Infinity) =>
  json.refine(
    json.record(reader),
    (value) =>
      Object.keys(value).length <= max &&
      Object.keys(value).every((key) => key.length <= keyLength),
  );
const linkSchema = json.object({
  title: json.optional(text),
  badge: json.optional(
    json.object({
      label: text,
      tone: json.enumeration(["neutral", "positive", "negative", "attention", "accent"]),
    }),
  ),
});
export const chatRowDisplaySchema = json.object({
  links: json.optional(boundedRecord(linkSchema, 8, 4096)),
  images: json.optional(
    boundedRecord(
      json.object({
        width: dimension,
        height: dimension,
        rendition: json.checked((value): value is 480 | 960 => value === 480 || value === 960),
        // Browser-local display bytes, never a ticket or an authorization receipt.
        thumbnail: json.optional(
          json.checked((value): value is Blob => value instanceof Blob && isChatThumbnail(value)),
        ),
      }),
      8,
      4096,
    ),
  ),
});
export const rowDisplaySchema = boundedRecord(chatRowDisplaySchema, 80);
export const avatarSourcesSchema = boundedRecord(
  json.nullable(json.refine(json.text, (value) => value.length <= 2048)),
  24,
);
export type ChatRowDisplayFacts = json.SnapshotValue<typeof chatRowDisplaySchema>;
export type ChatLinkDisplay = json.SnapshotValue<typeof linkSchema>;
type RowDisplaySnapshot = { rowDisplay?: Record<string, ChatRowDisplayFacts> };

export type ChatRowDisplay = {
  read: () => { scope: string; facts: ChatRowDisplayFacts | undefined } | undefined;
  write: (update: Partial<ChatRowDisplayFacts>) => void;
};

export type ChatDisplayFacts = {
  forRow: (messageId: string | null) => ChatRowDisplay | undefined;
};

/** Retain source identity, never signed transport URLs or embedded credentials. */
export function chatDisplaySourceKey(source: string): string | undefined {
  if (source.length > 2048 || /^(?:data|blob):/u.test(source)) {
    return undefined;
  }
  const url = globalThis.location && URL.parse(source, globalThis.location.origin);
  return url &&
    !url.username &&
    !url.password &&
    !url.hash &&
    !url.pathname.includes(ARTIFACT_DOWNLOAD_PATH) &&
    [...url.searchParams.keys()].every((key) => key === "v")
    ? source
    : undefined;
}

export function chatImageDisplayKey(
  image: { url?: string; artifactId?: string },
  rendition: 480 | 960,
): string | undefined {
  return image.url && !chatDisplaySourceKey(image.url)
    ? undefined
    : JSON.stringify([image.artifactId ?? null, image.url ?? null, rendition]);
}

/** Row display facts cover only this many newest rows. */
export const CHAT_ROW_DISPLAY_WINDOW = 80;

/** Display facts cannot outlive the transcript window they describe. */
export function projectChatRowDisplay(
  snapshot: RowDisplaySnapshot & { messages: unknown[] },
  start = 0,
): RowDisplaySnapshot["rowDisplay"] {
  if (!snapshot.rowDisplay) {
    return undefined;
  }
  const rows: NonNullable<RowDisplaySnapshot["rowDisplay"]> = {};
  for (const message of snapshot.messages.slice(
    Math.max(start, snapshot.messages.length - CHAT_ROW_DISPLAY_WINDOW),
  )) {
    const id = readChatThreadMessageIdentity(message)?.id;
    if (id && snapshot.rowDisplay[id] && removePairingQrContent(message) === message) {
      rows[id] = snapshot.rowDisplay[id]!;
    }
  }
  return Object.keys(rows).length === Object.keys(snapshot.rowDisplay).length
    ? snapshot.rowDisplay
    : rows;
}

export function chatThumbnailWeight(snapshot: RowDisplaySnapshot) {
  let count = 0;
  let bytes = 0;
  for (const row of Object.values(snapshot.rowDisplay ?? {})) {
    for (const image of Object.values(row.images ?? {})) {
      if (image.thumbnail) {
        count++;
        bytes += image.thumbnail.size;
      }
    }
  }
  return { count, bytes };
}

export function boundChatThumbnails<S extends RowDisplaySnapshot>(
  snapshot: S,
  budget = { count: MAX_CHAT_THUMBNAILS, bytes: MAX_CHAT_THUMBNAIL_BYTES },
): S {
  let rowDisplay: typeof snapshot.rowDisplay;
  for (const [id, row] of Object.entries(snapshot.rowDisplay ?? {}).toReversed()) {
    for (const [key, image] of Object.entries(row.images ?? {}).toReversed()) {
      const blob = image.thumbnail;
      if (!blob) {
        continue;
      }
      if (budget.count > 0 && blob.size <= budget.bytes && blob.size <= MAX_CHAT_THUMBNAIL_SIZE) {
        budget.count--;
        budget.bytes -= blob.size;
        continue;
      }
      rowDisplay ??= { ...snapshot.rowDisplay };
      if (rowDisplay[id] === row) {
        rowDisplay[id] = { ...row, images: { ...row.images } };
      }
      const { thumbnail: _thumbnail, ...dimensions } = image;
      rowDisplay[id]!.images![key] = dimensions;
    }
  }
  return rowDisplay ? { ...snapshot, rowDisplay } : snapshot;
}
