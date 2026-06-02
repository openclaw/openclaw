import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export type { DirectoryConfigParams } from "./plugins/directory-types.js";
export type { ChannelDirectoryEntry } from "./plugins/types.public.js";

/** Coarse explicit target class understood by shared channel target parsers. */
export type MessagingTargetKind = "user" | "channel";

/** Parsed target that retains raw input and normalized comparison material. */
export type MessagingTarget = {
  kind: MessagingTargetKind;
  id: string;
  raw: string;
  normalized: string;
};

/** Parser options for helpers that accept ambiguous user/channel target input. */
export type MessagingTargetParseOptions = {
  defaultKind?: MessagingTargetKind;
  ambiguousMessage?: string;
};

/** Build the canonical comparison key shared by channel target parsers and matchers. */
export function normalizeTargetId(kind: MessagingTargetKind, id: string): string {
  // Include the kind in the normalized key so a user id and channel id with the
  // same provider-native string never compare as the same destination.
  return normalizeLowercaseStringOrEmpty(`${kind}:${id}`);
}

/** Preserve the user-entered token while carrying a normalized match key. */
export function buildMessagingTarget(
  kind: MessagingTargetKind,
  id: string,
  raw: string,
): MessagingTarget {
  return {
    kind,
    id,
    raw,
    normalized: normalizeTargetId(kind, id),
  };
}

/** Validate a parsed target id with the channel-owned grammar before accepting it. */
export function ensureTargetId(params: {
  candidate: string;
  pattern: RegExp;
  errorMessage: string;
}): string {
  if (!params.pattern.test(params.candidate)) {
    throw new Error(params.errorMessage);
  }
  return params.candidate;
}

/** Parse a regex-backed mention token into a normalized messaging target. */
export function parseTargetMention(params: {
  raw: string;
  mentionPattern: RegExp;
  kind: MessagingTargetKind;
}): MessagingTarget | undefined {
  const match = params.raw.match(params.mentionPattern);
  if (!match?.[1]) {
    return undefined;
  }
  // Channel adapters own the mention regex and must put the provider-native id
  // in capture group 1; keeping that contract here avoids channel-specific
  // parsing branches in shared helpers.
  return buildMessagingTarget(params.kind, match[1], params.raw);
}

/** Parse an explicit kind prefix such as `user:` or `channel:`. */
export function parseTargetPrefix(params: {
  raw: string;
  prefix: string;
  kind: MessagingTargetKind;
}): MessagingTarget | undefined {
  if (!params.raw.startsWith(params.prefix)) {
    return undefined;
  }
  const id = params.raw.slice(params.prefix.length).trim();
  return id ? buildMessagingTarget(params.kind, id, params.raw) : undefined;
}

/** Try configured target prefixes in order and return the first successful parse. */
export function parseTargetPrefixes(params: {
  raw: string;
  prefixes: Array<{ prefix: string; kind: MessagingTargetKind }>;
}): MessagingTarget | undefined {
  // Prefix order is caller-owned so platform-specific spellings can win before
  // broader aliases that would parse the same raw token differently.
  for (const entry of params.prefixes) {
    const parsed = parseTargetPrefix({
      raw: params.raw,
      prefix: entry.prefix,
      kind: entry.kind,
    });
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

/** Accept legacy `@user` forms only after validating the post-`@` id. */
export function parseAtUserTarget(params: {
  raw: string;
  pattern: RegExp;
  errorMessage: string;
}): MessagingTarget | undefined {
  if (!params.raw.startsWith("@")) {
    return undefined;
  }
  const candidate = params.raw.slice(1).trim();
  const id = ensureTargetId({
    candidate,
    pattern: params.pattern,
    errorMessage: params.errorMessage,
  });
  return buildMessagingTarget("user", id, params.raw);
}

/** Resolve the supported explicit target syntaxes from most specific to broadest. */
export function parseMentionPrefixOrAtUserTarget(params: {
  raw: string;
  mentionPattern: RegExp;
  prefixes: Array<{ prefix: string; kind: MessagingTargetKind }>;
  atUserPattern: RegExp;
  atUserErrorMessage: string;
}): MessagingTarget | undefined {
  // Mention syntax wins over generic prefixes; legacy @user is the broadest fallback.
  const mentionTarget = parseTargetMention({
    raw: params.raw,
    mentionPattern: params.mentionPattern,
    kind: "user",
  });
  if (mentionTarget) {
    return mentionTarget;
  }
  const prefixedTarget = parseTargetPrefixes({
    raw: params.raw,
    prefixes: params.prefixes,
  });
  if (prefixedTarget) {
    return prefixedTarget;
  }
  return parseAtUserTarget({
    raw: params.raw,
    pattern: params.atUserPattern,
    errorMessage: params.atUserErrorMessage,
  });
}

/** Require a parsed target of the expected kind and return the provider-native id. */
export function requireTargetKind(params: {
  platform: string;
  target: MessagingTarget | undefined;
  kind: MessagingTargetKind;
}): string {
  const kindLabel = params.kind;
  if (!params.target) {
    throw new Error(`${params.platform} ${kindLabel} id is required.`);
  }
  if (params.target.kind !== params.kind) {
    // Mention the explicit prefix so ambiguous user/channel inputs can be
    // corrected without exposing the normalized internal key format.
    throw new Error(`${params.platform} ${kindLabel} id is required (use ${kindLabel}:<id>).`);
  }
  return params.target.id;
}
