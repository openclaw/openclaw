// Fenced MEDIA: acceptance predicate for #41966 diagnostics.
import {
  beginsIndependentMediaSource,
  cleanCandidate,
  FILE_URL_PREFIX_RE,
  hasTraversalOrUnsupportedHomeDirPrefix,
  isValidMedia,
  looksLikeLocalFilePath,
  MEDIA_TOKEN_RE,
  normalizeMediaSource,
  splitUnquotedMediaDirectiveParts,
  unwrapQuoted,
} from "./media-directive-validation.js";

/** True when a line contains at least one MEDIA: directive the normal parser would accept. */
export function lineHasAcceptableMediaDirective(line: string): boolean {
  if (!line.trimStart().toUpperCase().startsWith("MEDIA:")) {
    return false;
  }
  for (const match of line.matchAll(MEDIA_TOKEN_RE)) {
    const payload = match[1];
    if (payload == null) {
      continue;
    }
    const unwrapped = unwrapQuoted(payload);
    const payloadValue = unwrapped ?? payload;
    const parts = unwrapped ? [unwrapped] : splitUnquotedMediaDirectiveParts(payload);
    let validCount = 0;
    const invalidParts: string[] = [];
    let hasValidMedia = false;
    for (const part of parts) {
      const candidate = normalizeMediaSource(cleanCandidate(part));
      if (
        isValidMedia(candidate, unwrapped || /\s/.test(part) ? { allowSpaces: true } : undefined)
      ) {
        hasValidMedia = true;
        validCount += 1;
      } else if (!/\s/.test(part) || !hasTraversalOrUnsupportedHomeDirPrefix(candidate)) {
        invalidParts.push(part);
      }
    }

    const trimmedPayload = payloadValue.trim();
    const looksLikeLocalPath =
      looksLikeLocalFilePath(trimmedPayload) || FILE_URL_PREFIX_RE.test(trimmedPayload);
    if (
      !unwrapped &&
      validCount === 1 &&
      invalidParts.length > 0 &&
      !parts.slice(1).some(beginsIndependentMediaSource) &&
      /\s/.test(payloadValue) &&
      looksLikeLocalPath
    ) {
      const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
      if (isValidMedia(fallback, { allowSpaces: true })) {
        return true;
      }
    }

    if (!hasValidMedia && !unwrapped && /\s/.test(payloadValue)) {
      const spacedFallback = normalizeMediaSource(cleanCandidate(payloadValue));
      if (isValidMedia(spacedFallback, { allowSpaces: true, allowBareFilename: true })) {
        return true;
      }
    }

    if (!hasValidMedia) {
      const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
      if (isValidMedia(fallback, { allowSpaces: true, allowBareFilename: true })) {
        return true;
      }
    }

    if (hasValidMedia) {
      return true;
    }
  }
  return false;
}
