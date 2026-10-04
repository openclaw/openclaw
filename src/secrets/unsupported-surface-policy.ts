/** Defines unsupported secret-ref surfaces and operator-facing policy messages. */
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import { isRecord } from "../utils.js";

const CORE_UNSUPPORTED_SECRETREF_CONFIG_CANDIDATE_PATTERNS = [
  "hooks.token",
  "hooks.gmail.pushToken",
  "hooks.mappings[].sessionKey",
] as const;

type PatternToken =
  | { kind: "key"; key: string }
  | { kind: "array"; key: string }
  | { kind: "wildcard" };

const bundledChannelUnsupportedSecretRefSurfacePatterns = [
  ...new Set(
    GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.flatMap((entry) =>
      "unsupportedSecretRefSurfacePatterns" in entry
        ? (entry.unsupportedSecretRefSurfacePatterns ?? [])
        : [],
    ),
  ),
];

const unsupportedSecretRefSurfacePatterns = [
  ...CORE_UNSUPPORTED_SECRETREF_CONFIG_CANDIDATE_PATTERNS,
  "auth-profiles.oauth.*",
  ...bundledChannelUnsupportedSecretRefSurfacePatterns,
];

// Candidate scanning only sees openclaw.json; auth-profile-only surfaces are audited elsewhere.
const unsupportedSecretRefConfigCandidateTokens = [
  ...CORE_UNSUPPORTED_SECRETREF_CONFIG_CANDIDATE_PATTERNS,
  ...bundledChannelUnsupportedSecretRefSurfacePatterns,
].map(parseUnsupportedSecretRefSurfacePattern);

function parseUnsupportedSecretRefSurfacePattern(pattern: string): PatternToken[] {
  return pattern
    .split(".")
    .filter((segment) => segment.length > 0)
    .map<PatternToken>((segment) => {
      if (segment === "*") {
        return { kind: "wildcard" };
      }
      if (segment.endsWith("[]")) {
        return {
          kind: "array",
          key: segment.slice(0, -2),
        };
      }
      return {
        kind: "key",
        key: segment,
      };
    });
}

function collectPatternCandidates(params: {
  current: unknown;
  tokens: readonly PatternToken[];
  tokenIndex: number;
  pathSegments: string[];
  candidates: UnsupportedSecretRefConfigCandidate[];
}): void {
  if (params.tokenIndex >= params.tokens.length) {
    params.candidates.push({
      path: params.pathSegments.join("."),
      value: params.current,
    });
    return;
  }

  const token = params.tokens[params.tokenIndex];
  if (!token) {
    return;
  }

  if (token.kind === "wildcard") {
    if (!Array.isArray(params.current) && !isRecord(params.current)) {
      return;
    }
    const entries: Iterable<[string | number, unknown]> = Array.isArray(params.current)
      ? params.current.entries()
      : Object.entries(params.current);
    for (const [key, value] of entries) {
      collectPatternCandidates({
        ...params,
        current: value,
        tokenIndex: params.tokenIndex + 1,
        pathSegments: [...params.pathSegments, String(key)],
      });
    }
    return;
  }

  if (!isRecord(params.current) || !Object.hasOwn(params.current, token.key)) {
    return;
  }
  const value = params.current[token.key];
  if (token.kind === "array") {
    if (!Array.isArray(value)) {
      return;
    }
    for (const [index, entry] of value.entries()) {
      collectPatternCandidates({
        ...params,
        current: entry,
        tokenIndex: params.tokenIndex + 1,
        pathSegments: [...params.pathSegments, token.key, String(index)],
      });
    }
    return;
  }

  collectPatternCandidates({
    ...params,
    current: value,
    tokenIndex: params.tokenIndex + 1,
    pathSegments: [...params.pathSegments, token.key],
  });
}

type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

function collectUnsupportedSecretRefConfigCandidates(
  raw: unknown,
): UnsupportedSecretRefConfigCandidate[] {
  if (!isRecord(raw)) {
    return [];
  }

  const candidates: UnsupportedSecretRefConfigCandidate[] = [];
  for (const tokens of unsupportedSecretRefConfigCandidateTokens) {
    collectPatternCandidates({
      current: raw,
      tokens,
      tokenIndex: 0,
      pathSegments: [],
      candidates,
    });
  }
  return candidates;
}

export const unsupportedSecretRefSurfacePolicy = {
  listPatterns: () => [...unsupportedSecretRefSurfacePatterns],
  collectConfigCandidates: collectUnsupportedSecretRefConfigCandidates,
};
