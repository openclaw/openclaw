import { mediaKindFromMime, type MediaKind } from "@openclaw/media-core/constants";
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
  /** Internal proof that this exact fact was covered by a legacy staged projection. */
  staged?: boolean;
  // Structured persistence must preserve this marker across copies so a
  // deliberately suppressed attachment cannot silently rehydrate.
  hydrationSuppressed?: boolean;
};

export type MediaFactInput = {
  [Key in keyof MediaFact]?: MediaFact[Key] | null;
};

export type MediaFactDefaults<TInput extends MediaFactInput = MediaFactInput> = {
  kind?: MediaKind;
  messageId?: string;
  workspaceDir?: string;
  transcribed?: (media: TInput, index: number) => boolean;
};

/** Reads only the canonical persisted envelope; retired top-level carriers do not count. */
export function readPersistedMediaFactInputs(message: object): MediaFactInput[] | undefined {
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  const media =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).media
      : undefined;
  return Array.isArray(media) ? (media as MediaFactInput[]) : undefined;
}

/** Normalizes one fact without importing filesystem-only MIME detection into browsers. */
export function normalizeMediaFact<TInput extends MediaFactInput>(
  media: TInput,
  index: number,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact {
  // Sparse arrays serialize missing attachment positions as null; malformed
  // persisted slots must remain empty facts instead of crashing transcript hydration.
  const input =
    media && typeof media === "object" && !Array.isArray(media) ? media : ({} as TInput);
  const workspaceDir = normalizeOptionalString(input.workspaceDir) ?? defaults.workspaceDir;
  const contentType = normalizeOptionalString(input.contentType);
  const normalizedMime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return {
    path: normalizeOptionalString(input.path),
    url: normalizeOptionalString(input.url),
    contentType,
    kind: input.kind ?? defaults.kind ?? mediaKindFromMime(normalizedMime),
    transcribed: input.transcribed === true || defaults.transcribed?.(input, index) === true,
    messageId: normalizeOptionalString(input.messageId) ?? defaults.messageId,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(input.staged === true ? { staged: true } : {}),
    ...(input.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
}

/** Preserves sparse fact positions and every runtime normalization default. */
export function normalizeMediaFacts<TInput extends MediaFactInput>(
  media: readonly TInput[] | null | undefined,
  defaults: MediaFactDefaults<TInput> = {},
): MediaFact[] {
  return Array.isArray(media)
    ? media.map((entry, index) => normalizeMediaFact(entry, index, defaults))
    : [];
}

/** Reads normalized facts from the sole canonical persisted message envelope. */
export function readPersistedMediaFacts(message: object): MediaFact[] | undefined {
  const media = readPersistedMediaFactInputs(message);
  return media ? normalizeMediaFacts(media) : undefined;
}

// Empty facts preserve legacy positional alignment but are not attachments;
// treating placeholders as media would expose blank rows and misroute turns.
export function isMeaningfulMediaFact(fact: MediaFact): boolean {
  return Boolean(
    fact.path?.trim() ||
    fact.url?.trim() ||
    fact.contentType ||
    (fact.kind && fact.kind !== "unknown"),
  );
}
