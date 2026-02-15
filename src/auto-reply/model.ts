import { escapeRegExp } from "../utils.js";

export function extractModelDirective(
  body?: string,
  options?: { aliases?: string[] },
): {
  cleaned: string;
  rawModel?: string;
  rawProfile?: string;
  hasDirective: boolean;
  forceSwitch: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false, forceSwitch: false };
  }

  // Detect --force flag before matching model directive
  const forceSwitch = /(?:^|\s)--force(?:\s|$)/i.test(body);
  // Strip --force from body before model matching
  const bodyWithoutForce = forceSwitch
    ? body.replace(/(?:^|\s)--force(?:\s|$)/i, " ").trim()
    : body;

  const modelMatch = bodyWithoutForce.match(
    /(?:^|\s)\/model(?=$|\s|:)\s*:?\s*([A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*)?/i,
  );

  const aliases = (options?.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
  const aliasMatch =
    modelMatch || aliases.length === 0
      ? null
      : bodyWithoutForce.match(
          new RegExp(
            `(?:^|\\s)\\/(${aliases.map(escapeRegExp).join("|")})(?=$|\\s|:)(?:\\s*:\\s*)?`,
            "i",
          ),
        );

  const match = modelMatch ?? aliasMatch;
  const raw = modelMatch ? modelMatch?.[1]?.trim() : aliasMatch?.[1]?.trim();

  let rawModel = raw;
  let rawProfile: string | undefined;
  if (raw?.includes("@")) {
    const parts = raw.split("@");
    rawModel = parts[0]?.trim();
    rawProfile = parts.slice(1).join("@").trim() || undefined;
  }

  // Clean the original body (including --force removal)
  let cleaned = match
    ? bodyWithoutForce.replace(match[0], " ").replace(/\s+/g, " ").trim()
    : bodyWithoutForce.trim();
  // If --force was in the original but no model directive, restore the body
  if (!match && forceSwitch) {
    cleaned = body.trim();
  }

  return {
    cleaned,
    rawModel,
    rawProfile,
    hasDirective: !!match,
    forceSwitch: forceSwitch && !!match,
  };
}
