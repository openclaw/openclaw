export type MediaPayloadInput = {
  /** Local path or URL-like value passed through to legacy media fields. */
  path: string;
  /** Optional MIME type paired with this media entry. */
  contentType?: string;
};

/** Legacy media payload fields consumed by older channel/plugin adapters. */
export type MediaPayload = {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};

/**
 * Builds the legacy single-item and multi-item media payload fields from a
 * normalized media list.
 */
export function buildMediaPayload(
  mediaList: MediaPayloadInput[],
  opts?: { preserveMediaTypeCardinality?: boolean },
): MediaPayload {
  const first = mediaList[0];
  const mediaPaths = mediaList.map((media) => media.path);
  const rawMediaTypes = mediaList.map((media) => media.contentType ?? "");
  // Some adapters need `MediaTypes` length to match `MediaPaths`; others expect
  // omitted blanks to behave like the older sparse media payload shape.
  const mediaTypes = opts?.preserveMediaTypeCardinality
    ? rawMediaTypes
    : rawMediaTypes.filter((value): value is string => Boolean(value));
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
