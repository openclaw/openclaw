import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";

const MODEL_POLICY_COMPAT_SELECTORS = new Set(["openrouter:auto", "openrouter:free"]);

function hasValidSegments(segments: readonly string[], minimumLength: number): boolean {
  return (
    segments.length >= minimumLength &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        !segment.includes("*") &&
        !/\s/u.test(segment) &&
        !containsAsciiControlCharacter(segment),
    )
  );
}

type ModelPolicyWildcardRef = {
  key: string;
  provider: string;
};

/**
 * Parse and canonicalize a model-policy wildcard: a segment prefix ("provider/*",
 * "provider/namespace/*") or a model-name prefix ("provider/family-*").
 */
export function parseModelPolicyWildcardRef(raw: string): ModelPolicyWildcardRef | null {
  const trimmed = raw.trim();
  if (!trimmed.endsWith("*")) {
    return null;
  }
  // Segment padding is normalized; a model-name prefix keeps its exact characters.
  const parts = trimmed.slice(0, -1).split("/");
  const namePrefix = (parts.pop() ?? "").trimStart();
  const segments = parts.map((segment) => segment.trim());
  if (!hasValidSegments(segments, 1) || (namePrefix && !hasValidSegments([namePrefix], 1))) {
    return null;
  }
  const provider = normalizeProviderId(segments[0] ?? "");
  if (!provider) {
    return null;
  }
  return { key: `${[provider, ...segments.slice(1), namePrefix].join("/")}*`, provider };
}

/**
 * True when a canonical wildcard key from parseModelPolicyWildcardRef covers a provider/model key.
 * `*` may match nothing, so `provider/family-v1*` also covers `provider/family-v1`.
 */
export function modelPolicyWildcardMatches(wildcardKey: string, key: string): boolean {
  return key.startsWith(wildcardKey.slice(0, -1));
}

/** True for a syntactically valid exact provider/model policy reference. */
function isValidExactModelPolicyRef(raw: string): boolean {
  const parsed = parseModelCatalogRef(raw);
  return Boolean(parsed && hasValidSegments([parsed.provider, ...parsed.modelId.split("/")], 2));
}

/** Share policy grammar and owner-scoped aliases between validation and migration. */
export function createModelPolicyRefValidator(
  ...modelMaps: Array<Record<string, { alias?: string }> | undefined>
): (raw: string) => boolean {
  const aliases = new Set(
    modelMaps
      .flatMap((models) =>
        Object.values(models ?? {}).map((entry) => normalizeLowercaseStringOrEmpty(entry?.alias)),
      )
      .filter(Boolean),
  );
  return (raw) => {
    const trimmed = raw.trim();
    return Boolean(
      aliases.has(normalizeLowercaseStringOrEmpty(trimmed)) ||
      MODEL_POLICY_COMPAT_SELECTORS.has(normalizeLowercaseStringOrEmpty(trimmed)) ||
      isValidExactModelPolicyRef(trimmed) ||
      parseModelPolicyWildcardRef(trimmed),
    );
  };
}
