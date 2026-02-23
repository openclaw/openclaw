import { escapeRegExp } from "../utils.js";

export function extractModelDirective(
  body?: string,
  options?: { aliases?: string[] },
): {
  cleaned: string;
  rawModel?: string;
  rawProfile?: string;
  hasDirective: boolean;
} {
  if (!body) {
    return { cleaned: "", hasDirective: false };
  }

  const modelMatch = body.match(
    /(?:^|\s)\/model(?=$|\s|:)\s*:?\s*([A-Za-z0-9_.:@-]+(?:\/[A-Za-z0-9_.:@-]+)*)?/i,
  );

  const aliases = (options?.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
  const aliasMatch =
    modelMatch || aliases.length === 0
      ? null
      : body.match(
          new RegExp(
            `(?:^|\\s)\\/(${aliases.map(escapeRegExp).join("|")})(?=$|\\s|:)(?:\\s*:\\s*)?`,
            "i",
          ),
        );

  const match = modelMatch ?? aliasMatch;
  const raw = modelMatch ? modelMatch?.[1]?.trim() : aliasMatch?.[1]?.trim();

  let rawModel = raw;
  let rawProfile: string | undefined;
  if (raw) {
    const atIndex = raw.lastIndexOf("@");
    if (atIndex > 0) {
      const candidateModel = raw.slice(0, atIndex).trim();
      const candidateProfile = raw.slice(atIndex + 1).trim();
      if (candidateModel && candidateProfile && !candidateProfile.includes("/")) {
        rawModel = candidateModel;
        rawProfile = candidateProfile;
      }
    }
  }

  const cleaned = match ? body.replace(match[0], " ").replace(/\s+/g, " ").trim() : body.trim();

  return {
    cleaned,
    rawModel,
    rawProfile,
    hasDirective: !!match,
  };
}
