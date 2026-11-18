import { asOptionalObjectRecord as record } from "@openclaw/normalization-core/record-coerce";
import { isImageMediaFact, readPersistedMediaFacts } from "../media/media-facts.js";

export type TuiImageSource = { source: string; artifactId?: string };

/** Keep structured image references intact instead of recovering paths from rendered prose. */
export function extractTuiImageSources(message: unknown): TuiImageSource[] {
  const value = record(message);
  if (!value) {
    return [];
  }
  const images: TuiImageSource[] = [];
  const sources = new Set<string>();
  for (const block of Array.isArray(value.content) ? value.content : []) {
    const entry = record(block);
    if (!entry) {
      continue;
    }
    const attachment = entry.type === "attachment" ? record(entry.attachment) : undefined;
    const image = attachment ?? entry;
    if (
      attachment
        ? attachment.kind !== "image" &&
          attachment.kind !== "sticker" &&
          !(typeof attachment.mimeType === "string" && attachment.mimeType.startsWith("image/"))
        : entry.type !== "image" && entry.type !== "image_url" && entry.type !== "input_image"
    ) {
      continue;
    }
    const nestedSource = record(image.source);
    const url =
      image.url ??
      record(image.image_url)?.url ??
      image.image_url ??
      nestedSource?.url ??
      (typeof image.source === "string" ? image.source : undefined);
    const data = image.data ?? nestedSource?.data;
    const mimeType = image.mimeType ?? nestedSource?.media_type ?? nestedSource?.mimeType;
    const source =
      typeof url === "string" && url.trim()
        ? url.trim()
        : typeof data === "string" && typeof mimeType === "string"
          ? `data:${mimeType};base64,${data}`
          : undefined;
    if (source && !sources.has(source)) {
      sources.add(source);
      images.push({
        source,
        ...(typeof image.artifactId === "string" ? { artifactId: image.artifactId } : {}),
      });
    }
  }
  // Facts can retain images omitted from content, including mixed live/history representations.
  for (const fact of readPersistedMediaFacts(value) ?? []) {
    const source = fact.url || fact.path;
    if (source && isImageMediaFact(fact) && !sources.has(source)) {
      sources.add(source);
      images.push({ source });
    }
  }
  return images;
}
