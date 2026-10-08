/** Defines unsupported secret-ref surfaces and operator-facing policy messages. */
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import { isRecord } from "./shared.js";
import { expandPathTokens, parsePathPattern } from "./target-registry-pattern.js";

const CORE_UNSUPPORTED_SECRETREF_CONFIG_CANDIDATE_PATTERNS = [
  "hooks.token",
  "hooks.gmail.pushToken",
  "hooks.mappings[].sessionKey",
] as const;

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
].map((pattern) => parsePathPattern(pattern));

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

  return unsupportedSecretRefConfigCandidateTokens.flatMap((tokens) =>
    expandPathTokens(raw, tokens, { requireOwnKeys: true }).map(({ segments, value }) => ({
      path: segments.join("."),
      value,
    })),
  );
}

export const unsupportedSecretRefSurfacePolicy = {
  listPatterns: () => [...unsupportedSecretRefSurfacePatterns],
  collectConfigCandidates: collectUnsupportedSecretRefConfigCandidates,
};
