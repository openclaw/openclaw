// Session transcript path comparison helper.
// Normalizes transcript paths for cache, history, and update matching.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveRealpathOrAbsolute } from "../infra/boundary-path.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";

const transcriptUpdatePaths = new WeakMap<InternalSessionTranscriptUpdate, string | undefined>();
const transcriptUpdateStorePaths = new WeakMap<
  InternalSessionTranscriptUpdate,
  string | undefined
>();

/** Resolve a transcript file path into a stable comparison key. */
export function resolveTranscriptPathForComparison(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return resolveRealpathOrAbsolute(trimmed);
}

/** Share path resolution across a normalized event's synchronous listener fan-out. */
export function resolveTranscriptUpdatePathForComparison(
  update: InternalSessionTranscriptUpdate,
  source: "sessionFile" | "storePath" = "sessionFile",
): string | undefined {
  const paths = source === "storePath" ? transcriptUpdateStorePaths : transcriptUpdatePaths;
  if (paths.has(update)) {
    return paths.get(update);
  }
  const resolved = resolveTranscriptPathForComparison(
    source === "storePath" ? update.target?.storePath : update.sessionFile,
  );
  // The emitter creates a fresh event per update; later updates retry missing paths.
  paths.set(update, resolved);
  return resolved;
}
