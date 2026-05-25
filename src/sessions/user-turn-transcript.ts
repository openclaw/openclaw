export type PersistedUserTurnMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: string | null;
};

export type PersistedUserTurnMediaFields = {
  MediaPath?: string;
  MediaPaths?: string[];
  MediaType?: string;
  MediaTypes?: string[];
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function mediaTypeForTranscript(media: PersistedUserTurnMediaInput): string {
  return (
    normalizeOptionalText(media.contentType) ??
    normalizeOptionalText(media.kind) ??
    "application/octet-stream"
  );
}

export function buildPersistedUserTurnMediaFields(
  media: readonly PersistedUserTurnMediaInput[] | null | undefined,
): PersistedUserTurnMediaFields {
  const entries = Array.isArray(media) ? media : [];
  const paths = entries
    .map((entry) => normalizeOptionalText(entry.path) ?? normalizeOptionalText(entry.url))
    .filter((path): path is string => Boolean(path));
  if (paths.length === 0) {
    return {};
  }
  const types = entries
    .map((entry, index) => (paths[index] ? mediaTypeForTranscript(entry) : undefined))
    .filter((type): type is string => Boolean(type));
  return {
    MediaPath: paths[0],
    MediaPaths: paths,
    MediaType: types[0],
    MediaTypes: types,
  };
}
