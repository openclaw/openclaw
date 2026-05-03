export type MediaPayloadInput = {
  path: string;
  contentType?: string;
};

export type MediaPayload = {
  MediaPath?: string;
  MediaType?: string;
  MediaUrl?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
};

export function buildMediaPayload(
  mediaList: MediaPayloadInput[],
  opts?: { preserveMediaTypeCardinality?: boolean },
): MediaPayload {
  const first = mediaList[0];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  for (const media of mediaList) {
    mediaPaths.push(media.path);
    const contentType = media.contentType ?? "";
    if (opts?.preserveMediaTypeCardinality || contentType) {
      mediaTypes.push(contentType);
    }
  }
  return {
    MediaPath: first?.path,
    MediaType: first?.contentType,
    MediaUrl: first?.path,
    MediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaUrls: mediaPaths.length > 0 ? mediaPaths : undefined,
    MediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
  };
}
