import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Resolves transcript paths to a stable comparable form, tolerating files not yet created. */
export function resolveTranscriptPathForComparison(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // New transcripts may be compared before the file exists; path.resolve still
    // canonicalizes relative input enough for candidate/update matching.
    return resolved;
  }
}
