import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { parseStrictInteger } from "../../infra/parse-finite-number.js";

/** Service prefix that maps a user-facing target prefix to a channel service id. */
export type ServicePrefix<TService extends string> = { prefix: string; service: TService };

/** Prefix groups used to parse chat id, GUID, and human-readable chat identifiers. */
export type ChatTargetPrefixesParams = {
  trimmed: string;
  lower: string;
  chatIdPrefixes: string[];
  chatGuidPrefixes: string[];
  chatIdentifierPrefixes: string[];
};

/** Parsed conversation target from strict chat id/GUID/identifier prefixes. */
export type ParsedChatTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string };

/** Parsed allowlist entry that may authorize either a conversation target or sender handle. */
export type ParsedChatAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

/** Inputs for checking a parsed allowlist against a sender and optional conversation target. */
export type ChatSenderAllowParams = {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  allowConversationTargets?: boolean | null;
};

/** Matches allowlist entries against sender handles and opt-in conversation targets. */
export function isAllowedParsedChatSender(params: {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  allowConversationTargets?: boolean | null;
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean {
  const allowFrom = normalizeStringEntries(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }

  const senderNormalized = params.normalizeSender(params.sender);
  const allowConversationTargets = params.allowConversationTargets === true;
  // Conversation targets authorize whole chats, so callers must opt in per channel surface.
  const chatId = allowConversationTargets ? (params.chatId ?? undefined) : undefined;
  const chatGuid = allowConversationTargets ? normalizeOptionalString(params.chatGuid) : undefined;
  const chatIdentifier = allowConversationTargets
    ? normalizeOptionalString(params.chatIdentifier)
    : undefined;

  for (const entry of allowFrom) {
    if (!entry) {
      continue;
    }
    const parsed = params.parseAllowTarget(entry);
    if (parsed.kind === "chat_id" && chatId !== undefined) {
      if (parsed.chatId === chatId) {
        return true;
      }
    } else if (parsed.kind === "chat_guid" && chatGuid) {
      if (parsed.chatGuid === chatGuid) {
        return true;
      }
    } else if (parsed.kind === "chat_identifier" && chatIdentifier) {
      if (parsed.chatIdentifier === chatIdentifier) {
        return true;
      }
    } else if (parsed.kind === "handle" && senderNormalized) {
      if (parsed.handle === senderNormalized) {
        return true;
      }
    }
  }
  return false;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

function startsWithAnyPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

/** Resolves service-prefixed handles, delegating chat-looking remainders to a parser. */
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

/** Resolves service-prefixed targets while preserving nested chat target grammar. */
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
    trimmed: params.trimmed,
    lower: params.lower,
    servicePrefixes: params.servicePrefixes,
    isChatTarget: (remainderLower) => startsWithAnyPrefix(remainderLower, chatPrefixes),
    parseTarget: params.parseTarget,
  });
}

/** Parses strict chat target prefixes and throws when a matching prefix has invalid payload. */
export function parseChatTargetPrefixesOrThrow(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = parseStrictInteger(value);
      if (chatId === undefined) {
        throw new Error(`Invalid chat_id: ${value}`);
      }
      return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_guid is required");
      }
      return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (!value) {
        throw new Error("chat_identifier is required");
      }
      return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  return null;
}

/** Parses service-prefixed allowlist entries using the channel-owned allow target parser. */
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

/** Parses allowlist entries that may be service-prefixed handles or native chat targets. */
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
  const servicePrefixed = resolveServicePrefixedAllowTarget({
    trimmed: params.trimmed,
    lower: params.lower,
    servicePrefixes: params.servicePrefixes,
    parseAllowTarget: params.parseAllowTarget,
  });
  if (servicePrefixed) {
    return servicePrefixed as TAllowTarget;
  }

  const chatTarget = parseChatAllowTargetPrefixes({
    trimmed: params.trimmed,
    lower: params.lower,
    chatIdPrefixes: params.chatIdPrefixes,
    chatGuidPrefixes: params.chatGuidPrefixes,
    chatIdentifierPrefixes: params.chatIdentifierPrefixes,
  });
  if (chatTarget) {
    return chatTarget as TAllowTarget;
  }
  return null;
}

/** Creates a reusable sender matcher with channel-specific parsing and normalization. */
export function createAllowedChatSenderMatcher(params: {
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
  allowConversationTargets?: boolean;
}): (input: ChatSenderAllowParams) => boolean {
  return (input) =>
    isAllowedParsedChatSender({
      allowFrom: input.allowFrom,
      sender: input.sender,
      chatId: input.chatId,
      chatGuid: input.chatGuid,
      chatIdentifier: input.chatIdentifier,
      allowConversationTargets:
        input.allowConversationTargets ?? params.allowConversationTargets ?? false,
      normalizeSender: params.normalizeSender,
      parseAllowTarget: params.parseAllowTarget,
    });
}

/** Parses allowlist chat targets leniently, returning null for invalid prefix payloads. */
export function parseChatAllowTargetPrefixes(
  params: ChatTargetPrefixesParams,
): ParsedChatTarget | null {
  for (const prefix of params.chatIdPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      const chatId = parseStrictInteger(value);
      if (chatId !== undefined) {
        return { kind: "chat_id", chatId };
      }
    }
  }

  for (const prefix of params.chatGuidPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { kind: "chat_guid", chatGuid: value };
      }
    }
  }

  for (const prefix of params.chatIdentifierPrefixes) {
    if (params.lower.startsWith(prefix)) {
      const value = stripPrefix(params.trimmed, prefix);
      if (value) {
        return { kind: "chat_identifier", chatIdentifier: value };
      }
    }
  }

  return null;
}
