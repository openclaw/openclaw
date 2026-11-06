import { parseStrictInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveAllowlistMatchByCandidates } from "../allowlist-match.js";

export type ServicePrefix<TService extends string> = { prefix: string; service: TService };

export type ChatTargetPrefixesParams = {
  trimmed: string;
  lower: string;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
};

export type ParsedChatTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string };

export type ParsedChatAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

export type ChatSenderAllowParams = {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  allowConversationTargets?: boolean | null;
};

export function isAllowedParsedChatSender(
  params: ChatSenderAllowParams & {
    normalizeSender: (sender: string) => string;
    parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
  },
): boolean {
  const allowFrom = normalizeStringEntries(params.allowFrom);
  const senderNormalized = params.normalizeSender(params.sender);
  const allowConversationTargets = params.allowConversationTargets === true;
  // Conversation ids are only considered when the channel opts in; otherwise
  // allowlists stay sender-handle based for compatibility with older configs.
  const chatId = allowConversationTargets ? (params.chatId ?? undefined) : undefined;
  const chatGuid = allowConversationTargets ? normalizeOptionalString(params.chatGuid) : undefined;
  const chatIdentifier = allowConversationTargets
    ? normalizeOptionalString(params.chatIdentifier)
    : undefined;

  const normalizedAllowFrom = allowFrom.map((entry) => {
    if (entry === "*") {
      return entry;
    }
    const parsed = params.parseAllowTarget(entry);
    if (parsed.kind === "chat_id") {
      return `chat_id:${parsed.chatId}`;
    }
    if (parsed.kind === "chat_guid") {
      return `chat_guid:${parsed.chatGuid}`;
    }
    if (parsed.kind === "chat_identifier") {
      return `chat_identifier:${parsed.chatIdentifier}`;
    }
    return `handle:${parsed.handle}`;
  });
  return resolveAllowlistMatchByCandidates({
    allowList: normalizedAllowFrom,
    candidates: [
      { value: senderNormalized ? `handle:${senderNormalized}` : undefined, source: "handle" },
      { value: chatId !== undefined ? `chat_id:${chatId}` : undefined, source: "chat_id" },
      { value: chatGuid ? `chat_guid:${chatGuid}` : undefined, source: "chat_guid" },
      {
        value: chatIdentifier ? `chat_identifier:${chatIdentifier}` : undefined,
        source: "chat_identifier",
      },
    ],
  }).allowed;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

export function resolveServicePrefixedTarget<TService extends string, TTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<ServicePrefix<TService>>;
  isChatTarget: (remainderLower: string) => boolean;
  parseTarget: (remainder: string) => TTarget;
}): ({ kind: "handle"; to: string; service: TService } | TTarget) | null {
  for (const { prefix, service } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      throw new Error(`${prefix} target is required`);
    }
    const remainderLower = normalizeLowercaseStringOrEmpty(remainder);
    if (params.isChatTarget(remainderLower)) {
      return params.parseTarget(remainder);
    }
    return { kind: "handle", to: remainder, service };
  }
  return null;
}

export function resolveServicePrefixedChatTarget<TService extends string, TTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<ServicePrefix<TService>>;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
  extraChatPrefixes?: string[];
  parseTarget: (remainder: string) => TTarget;
}): ({ kind: "handle"; to: string; service: TService } | TTarget) | null {
  const chatPrefixes = [
    ...params.chatIdPrefixes,
    ...params.chatGuidPrefixes,
    ...params.chatIdentifierPrefixes,
    ...(params.extraChatPrefixes ?? []),
  ];
  return resolveServicePrefixedTarget({
    ...params,
    isChatTarget: (remainderLower) =>
      chatPrefixes.some((prefix) => remainderLower.startsWith(prefix)),
  });
}

/** Reject malformed prefixed values instead of treating them as sender handles. */
export function parseChatTargetPrefixesOrThrow(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  return parseChatTargetPrefixes(params, true);
}

function parseChatTargetPrefixes(
  params: ChatTargetPrefixesParams,
  throwOnInvalid: boolean,
): ParsedChatTarget | null {
  for (const [kind, prefixes] of [
    ["chat_id", params.chatIdPrefixes],
    ["chat_guid", params.chatGuidPrefixes],
    ["chat_identifier", params.chatIdentifierPrefixes],
  ] as const) {
    for (const prefix of prefixes) {
      if (!params.lower.startsWith(prefix)) {
        continue;
      }
      const value = stripPrefix(params.trimmed, prefix);
      if (kind === "chat_id") {
        const chatId = parseStrictInteger(value);
        if (chatId !== undefined) {
          return { kind, chatId };
        }
      } else if (value) {
        return kind === "chat_guid" ? { kind, chatGuid: value } : { kind, chatIdentifier: value };
      }
      if (throwOnInvalid) {
        throw new Error(kind === "chat_id" ? `Invalid chat_id: ${value}` : `${kind} is required`);
      }
    }
  }

  return null;
}

export function resolveServicePrefixedAllowTarget<TAllowTarget>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<{ prefix: string }>;
  parseAllowTarget: (remainder: string) => TAllowTarget;
}): (TAllowTarget | { kind: "handle"; handle: string }) | null {
  for (const { prefix } of params.servicePrefixes) {
    if (!params.lower.startsWith(prefix)) {
      continue;
    }
    const remainder = stripPrefix(params.trimmed, prefix);
    if (!remainder) {
      return { kind: "handle", handle: "" };
    }
    return params.parseAllowTarget(remainder);
  }
  return null;
}

export function resolveServicePrefixedOrChatAllowTarget<
  TAllowTarget extends ParsedChatAllowTarget,
>(params: {
  trimmed: string;
  lower: string;
  servicePrefixes: Array<{ prefix: string }>;
  parseAllowTarget: (remainder: string) => TAllowTarget;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
}): TAllowTarget | null {
  const servicePrefixed = resolveServicePrefixedAllowTarget(params);
  if (servicePrefixed) {
    return servicePrefixed as TAllowTarget;
  }

  return parseChatAllowTargetPrefixes(params) as TAllowTarget | null;
}

export function createAllowedChatSenderMatcher(params: {
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
  allowConversationTargets?: boolean;
}): (input: ChatSenderAllowParams) => boolean {
  return (input) =>
    isAllowedParsedChatSender({
      ...input,
      allowConversationTargets:
        input.allowConversationTargets ?? params.allowConversationTargets ?? false,
      normalizeSender: params.normalizeSender,
      parseAllowTarget: params.parseAllowTarget,
    });
}

/** Ignore malformed prefixes while checking allowlist entries. */
export function parseChatAllowTargetPrefixes(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  return parseChatTargetPrefixes(params, false);
}

/** Remove one of the known provider prefixes from a free-form target string. */
export function stripChannelTargetPrefix(raw: string, ...providers: string[]): string {
  const trimmed = raw.trim();
  for (const provider of providers) {
    const prefix = `${normalizeLowercaseStringOrEmpty(provider)}:`;
    if (normalizeLowercaseStringOrEmpty(trimmed).startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

/** Remove generic target-kind prefixes such as `user:` or `group:`. */
export function stripTargetKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}
