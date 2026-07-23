import type { MediaKind } from "@openclaw/media-core/constants";
import { kindFromMime, mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PromptImageOrderEntry } from "./prompt-image-order.js";

/** One ordered runtime attachment; array position is its alignment identity. */
export type MediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaKind;
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
  // Declared field, not a symbol: suppression must survive every fact copy or
  // reprojection boundary; described images otherwise rehydrate or count failed.
  // Structured persistence may retain it; legacy Media* projections never emit it.
  hydrationSuppressed?: boolean;
};

export type MediaFactInput = {
  [Key in keyof MediaFact]?: MediaFact[Key] | null;
};

const RUNTIME_PROMPT_MEDIA_FACTS = Symbol.for("openclaw.runtimePromptMediaFacts");

/** Attaches facts to a runtime prompt message without changing serialized/model-visible bytes. */
export function attachRuntimePromptMediaFacts<T extends object>(
  message: T,
  media: readonly MediaFact[],
  imageOrder?: readonly PromptImageOrderEntry[],
): T {
  const normalized = normalizeMediaFacts(media);
  if (imageOrder?.length) {
    Object.defineProperty(normalized, "imageOrder", { value: [...imageOrder] });
  }
  Object.defineProperty(message, RUNTIME_PROMPT_MEDIA_FACTS, {
    configurable: true,
    value: normalized,
  });
  return message;
}

export function readRuntimePromptMediaFacts(message: object): MediaFact[] | undefined {
  const media = (message as Record<PropertyKey, unknown>)[RUNTIME_PROMPT_MEDIA_FACTS];
  return Array.isArray(media) ? (media as MediaFact[]) : undefined;
}

export function readRuntimePromptImageOrder(message: object): PromptImageOrderEntry[] | undefined {
  const imageOrder = (
    readRuntimePromptMediaFacts(message) as
      | (MediaFact[] & { imageOrder?: PromptImageOrderEntry[] })
      | undefined
  )?.imageOrder;
  return Array.isArray(imageOrder) ? (imageOrder as PromptImageOrderEntry[]) : undefined;
}

/** Returns whether a fact can produce native image input. */
export function isImageMediaFact(fact: MediaFactInput): boolean {
  if (fact.kind && fact.kind !== "unknown") {
    return fact.kind === "image" || fact.kind === "sticker";
  }
  const contentType = normalizeOptionalString(fact.contentType);
  const normalizedContentType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (
    normalizedContentType &&
    normalizedContentType !== "application/octet-stream" &&
    normalizedContentType !== "binary/octet-stream"
  ) {
    const mimeKind = kindFromMime(normalizedContentType);
    if (mimeKind) {
      return mimeKind === "image";
    }
    // Legacy channel-mode projections persist bare kinds as MediaType; honor
    // them, and fall through to filename inference for other unknown strings.
    if (normalizedContentType === "image" || normalizedContentType === "sticker") {
      return true;
    }
    if (
      normalizedContentType === "audio" ||
      normalizedContentType === "video" ||
      normalizedContentType === "document"
    ) {
      return false;
    }
  }
  const pathValue = normalizeOptionalString(fact.path) ?? normalizeOptionalString(fact.url);
  return kindFromMime(mimeTypeFromFilePath(pathValue)) === "image";
}

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

type MediaFactSource = MediaFactLegacyProjection & {
  media?: readonly MediaFactInput[];
  MediaStaged?: boolean | null;
  MediaWorkspaceDir?: string | null;
};

function normalizeMediaFact<TInput extends MediaFactInput>(
  media: TInput,
  index: number,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact {
  const workspaceDir = normalizeOptionalString(media.workspaceDir) ?? defaults.workspaceDir;
  const contentType = normalizeOptionalString(media.contentType);
  const normalized: MediaFact = {
    path: normalizeOptionalString(media.path),
    url: normalizeOptionalString(media.url),
    contentType,
    kind: media.kind ?? defaults.kind ?? kindFromMime(contentType),
    transcribed: media.transcribed === true || defaults.transcribed?.(media, index) === true,
    messageId: normalizeOptionalString(media.messageId) ?? defaults.messageId,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
  return normalized;
}

/** True when a consumer must use the already-staged legacy path projection. */
export function hasStagedMediaProjection(source: MediaFactSource): boolean {
  return source.MediaStaged === true || Boolean(normalizeOptionalString(source.MediaWorkspaceDir));
}

export function normalizeMediaFacts<TInput extends MediaFactInput>(
  media: readonly TInput[] | null | undefined,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact[] {
  return Array.isArray(media)
    ? media.map((entry, index) => normalizeMediaFact(entry, index, defaults))
    : [];
}

// Empty slots exist only to keep legacy parallel-array positions aligned;
// presence/counting sites must ignore them or blank projections ({MediaPaths: [""]})
// route media-less messages into inbound-media handling.
function isMeaningfulMediaFact(fact: MediaFact): boolean {
  return Boolean(
    fact.path?.trim() ||
    fact.url?.trim() ||
    fact.contentType ||
    (fact.kind && fact.kind !== "unknown"),
  );
}

/** Resolves facts and drops alignment-only empty slots for presence/count consumers. */
export function resolveMeaningfulMediaFacts(source: MediaFactSource): MediaFact[] {
  return resolveMediaFacts(source).filter(isMeaningfulMediaFact);
}

/** Normalizes canonical facts or, for compatibility callers, legacy parallel fields. */
export function resolveMediaFacts(source: MediaFactSource): MediaFact[] {
  const canonical = normalizeMediaFacts(source.media);
  const paths = Array.isArray(source.MediaPaths) ? source.MediaPaths : [];
  const urls = Array.isArray(source.MediaUrls) ? source.MediaUrls : [];
  const types = Array.isArray(source.MediaTypes) ? source.MediaTypes : [];
  const count = Math.max(
    canonical.length,
    paths.length,
    urls.length,
    types.length,
    source.MediaPath || source.MediaUrl ? 1 : 0,
  );
  const transcribed = new Set(source.MediaTranscribedIndexes ?? []);
  return Array.from({ length: count }, (_, index) => {
    const fact = canonical[index];
    return normalizeMediaFact(
      {
        path: fact?.path ?? paths[index] ?? (index === 0 ? source.MediaPath : undefined),
        url:
          fact?.url ??
          urls[index] ??
          (paths.length > 0 || index === 0 ? source.MediaUrl : undefined),
        contentType:
          fact?.contentType ??
          normalizeOptionalString(types[index]) ??
          (index === 0 ? source.MediaType : undefined),
        kind: fact?.kind,
        transcribed: fact?.transcribed === true || transcribed.has(index),
        messageId: fact?.messageId,
        workspaceDir:
          normalizeOptionalString(fact?.workspaceDir) ??
          normalizeOptionalString(source.MediaWorkspaceDir),
        hydrationSuppressed: fact?.hydrationSuppressed,
      },
      index,
    );
  });
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
