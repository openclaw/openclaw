import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";

export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

const SYSTEM_PROMPT_CACHE_BOUNDARY_COMMENT = SYSTEM_PROMPT_CACHE_BOUNDARY.trim();

export function stripSystemPromptCacheBoundary(text: string): string {
  return text.replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n");
}

export function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const boundaryIndex = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return {
    stablePrefix: text.slice(0, boundaryIndex).trimEnd(),
    dynamicSuffix: text.slice(boundaryIndex + SYSTEM_PROMPT_CACHE_BOUNDARY.length).trimStart(),
  };
}

/**
 * Synthesize a cache-boundary marker at the end of `systemPrompt` when one is
 * not already present. Idempotent: returns the input unchanged when a marker
 * exists. Used by top-level prompt-assembly call sites that want to guarantee
 * downstream marker-aware helpers can place additions in the dynamic-suffix
 * region.
 */
export function ensureSystemPromptCacheBoundary(systemPrompt: string): string {
  if (systemPrompt.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)) {
    return systemPrompt;
  }
  const trimmed = systemPrompt.trimEnd();
  if (!trimmed) {
    return SYSTEM_PROMPT_CACHE_BOUNDARY;
  }
  return `${trimmed}${SYSTEM_PROMPT_CACHE_BOUNDARY}`;
}

// Strip any embedded cache-boundary marker (full or comment-only form) from an
// addition so it cannot reach the provider as literal sentinel text. Downstream
// cache-control split uses indexOf and only matches the first marker, so a
// secondary marker carried in via prepend/append context would be sent verbatim
// to the model.
function sanitizeAdditionMarkers(addition: string): string {
  if (
    !addition.includes(SYSTEM_PROMPT_CACHE_BOUNDARY) &&
    !addition.includes(SYSTEM_PROMPT_CACHE_BOUNDARY_COMMENT)
  ) {
    return addition;
  }
  return addition
    .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n")
    .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY_COMMENT, "");
}

function normalizeAddition(addition: string | undefined): string {
  if (typeof addition !== "string") {
    return "";
  }
  const sanitized = sanitizeAdditionMarkers(addition);
  return sanitized ? normalizeStructuredPromptSection(sanitized) : "";
}

export function prependSystemPromptAdditionAfterCacheBoundary(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  const systemPromptAddition = normalizeAddition(params.systemPromptAddition);
  if (!systemPromptAddition) {
    return params.systemPrompt;
  }

  const split = splitSystemPromptCacheBoundary(params.systemPrompt);
  if (!split) {
    return `${systemPromptAddition}\n\n${params.systemPrompt}`;
  }

  const dynamicSuffix = split.dynamicSuffix
    ? normalizeStructuredPromptSection(split.dynamicSuffix)
    : "";
  if (!dynamicSuffix) {
    return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}`;
  }

  return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}\n\n${dynamicSuffix}`;
}

/**
 * Append `systemPromptAddition` below the cache-boundary marker, in the
 * dynamic-suffix region. When the input has no marker, falls back to a
 * markerless `systemPrompt + "\n\n" + addition` join. Embedded marker
 * substrings inside the addition are stripped (both the full marker and its
 * trimmed comment form) so a smuggled sentinel cannot mislead downstream
 * marker-aware splits that match only the first occurrence.
 */
export function appendSystemPromptAdditionAfterCacheBoundary(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  const systemPromptAddition = normalizeAddition(params.systemPromptAddition);
  if (!systemPromptAddition) {
    return params.systemPrompt;
  }

  const split = splitSystemPromptCacheBoundary(params.systemPrompt);
  if (!split) {
    return `${params.systemPrompt}\n\n${systemPromptAddition}`;
  }

  const dynamicSuffix = split.dynamicSuffix
    ? normalizeStructuredPromptSection(split.dynamicSuffix)
    : "";
  if (!dynamicSuffix) {
    return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}`;
  }

  return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamicSuffix}\n\n${systemPromptAddition}`;
}
