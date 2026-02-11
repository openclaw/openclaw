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
  if (raw?.includes("@")) {
    // Find the last @ that could be an auth profile separator.
    // Only treat @ as a separator when used as a trailing profile override
    // (i.e., no '/' characters after the '@'). This preserves OpenRouter
    // preset paths like "openrouter/@preset/model-name" and any model paths
    // containing @ in path segments like "provider/foo@bar/baz".
    const atIndex = raw.lastIndexOf("@");
    const afterAt = raw.slice(atIndex + 1);
    if (!afterAt.includes("/")) {
      rawModel = raw.slice(0, atIndex).trim();
      rawProfile = afterAt.trim() || undefined;
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
