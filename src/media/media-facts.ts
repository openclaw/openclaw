import type { MediaKind } from "@openclaw/media-core/constants";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** One ordered runtime attachment; array position is its alignment identity. */
export type MediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaKind;
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
};

export type MediaFactInput = {
  [Key in keyof MediaFact]?: MediaFact[Key] | null;
};

type MediaFactDefaults<TInput extends MediaFactInput = MediaFactInput> = {
  kind?: MediaKind;
  messageId?: string;
  workspaceDir?: string;
  transcribed?: (media: TInput, index: number) => boolean;
};

export type MediaFactLegacyProjection = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  MediaTranscribedIndexes?: number[];
};

function normalizeMediaFact<TInput extends MediaFactInput>(
  media: TInput,
  index: number,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact {
  const workspaceDir = normalizeOptionalString(media.workspaceDir) ?? defaults.workspaceDir;
  return {
    path: normalizeOptionalString(media.path),
    url: normalizeOptionalString(media.url),
    contentType: normalizeOptionalString(media.contentType),
    kind: media.kind ?? defaults.kind,
    transcribed: media.transcribed === true || defaults.transcribed?.(media, index) === true,
    messageId: normalizeOptionalString(media.messageId) ?? defaults.messageId,
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

export function normalizeMediaFacts<TInput extends MediaFactInput>(
  media: readonly TInput[] | null | undefined,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact[] {
  return Array.isArray(media)
    ? media.map((entry, index) => normalizeMediaFact(entry, index, defaults))
    : [];
}

function projectStrings(
  values: Array<string | null | undefined>,
  compact: boolean,
  preserveEmptyLists: boolean,
): string[] | undefined {
  const projected = compact
    ? values.filter((value): value is string => Boolean(value))
    : values.map((value) => value ?? "");
  if (projected.length === 0 || (!preserveEmptyLists && !projected.some(Boolean))) {
    return undefined;
  }
  return projected;
}

export function projectMediaFacts(
  media: readonly MediaFactInput[] | null | undefined,
  mode: "channel" | "compact" | "aligned" = "channel",
): MediaFactLegacyProjection {
  const entries = Array.isArray(media) ? media : [];
  const preserveEmptyLists = mode !== "channel";
  const mediaUrl = (entry: MediaFactInput) =>
    (mode === "channel" ? (entry.url ?? entry.path) : entry.path) ?? undefined;
  const mediaType = (entry: MediaFactInput) =>
    entry.contentType ?? (mode === "channel" ? entry.kind : undefined) ?? undefined;
  const transcribedIndexes = entries.flatMap((entry, index) => (entry.transcribed ? [index] : []));
  return {
    MediaPath: entries[0]?.path ?? undefined,
    MediaUrl: entries[0] ? mediaUrl(entries[0]) : undefined,
    MediaType: entries[0] ? mediaType(entries[0]) : undefined,
    MediaPaths: projectStrings(
      entries.map((entry) => entry.path),
      false,
      preserveEmptyLists,
    ),
    MediaUrls: projectStrings(entries.map(mediaUrl), false, preserveEmptyLists),
    MediaTypes: projectStrings(entries.map(mediaType), mode === "compact", preserveEmptyLists),
    ...(mode !== "channel"
      ? {}
      : {
          MediaTranscribedIndexes: transcribedIndexes.length > 0 ? transcribedIndexes : undefined,
        }),
  };
}
