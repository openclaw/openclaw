import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const REQUIRED_EXTERNAL_REL_TOKENS = ["noopener", "noreferrer"] as const;

export const EXTERNAL_LINK_TARGET = "_blank";

export function buildExternalLinkRel(currentRel?: string): string {
  const tokens = new Set<string>(REQUIRED_EXTERNAL_REL_TOKENS);

  for (const rawToken of (currentRel ?? "").split(/\s+/)) {
    const token = normalizeOptionalLowercaseString(rawToken);
    if (token) {
      tokens.add(token);
    }
  }

  return [...tokens].join(" ");
}
