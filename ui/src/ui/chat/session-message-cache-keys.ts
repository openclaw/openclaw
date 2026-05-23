import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  parseAgentSessionKey,
} from "../session-key.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

export type ChatMessageCacheSessionDefaults = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
};

const DEFAULT_CANONICAL_MAIN_SESSION_KEY = buildAgentMainSessionKey({
  agentId: DEFAULT_AGENT_ID,
  mainKey: DEFAULT_MAIN_KEY,
});

function toTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveDefaultMainSessionKey(defaults?: ChatMessageCacheSessionDefaults): string {
  return (
    toTrimmedString(defaults?.mainSessionKey) ??
    buildAgentMainSessionKey({
      agentId: toTrimmedString(defaults?.defaultAgentId) ?? DEFAULT_AGENT_ID,
      mainKey: toTrimmedString(defaults?.mainKey) ?? DEFAULT_MAIN_KEY,
    })
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

export function readChatMessageCacheSessionDefaults(
  host: unknown,
): ChatMessageCacheSessionDefaults | undefined {
  if (!host || typeof host !== "object" || !("hello" in host)) {
    return undefined;
  }
  const { hello } = host;
  if (!hello || typeof hello !== "object" || !("snapshot" in hello)) {
    return undefined;
  }
  const { snapshot } = hello;
  if (!snapshot || typeof snapshot !== "object" || !("sessionDefaults" in snapshot)) {
    return undefined;
  }
  const { sessionDefaults } = snapshot;
  if (!sessionDefaults || typeof sessionDefaults !== "object") {
    return undefined;
  }
  return {
    defaultAgentId:
      "defaultAgentId" in sessionDefaults && typeof sessionDefaults.defaultAgentId === "string"
        ? sessionDefaults.defaultAgentId
        : undefined,
    mainKey:
      "mainKey" in sessionDefaults && typeof sessionDefaults.mainKey === "string"
        ? sessionDefaults.mainKey
        : undefined,
    mainSessionKey:
      "mainSessionKey" in sessionDefaults && typeof sessionDefaults.mainSessionKey === "string"
        ? sessionDefaults.mainSessionKey
        : undefined,
  };
}

export function normalizeChatMessageCacheSessionKey(
  sessionKey: string,
  defaults?: ChatMessageCacheSessionDefaults,
): string {
  const raw = sessionKey.trim();
  const normalized = normalizeLowercaseStringOrEmpty(raw);
  const mainKey = toTrimmedString(defaults?.mainKey) ?? DEFAULT_MAIN_KEY;
  const defaultAgentId = toTrimmedString(defaults?.defaultAgentId) ?? DEFAULT_AGENT_ID;
  const defaultMainSessionKey = resolveDefaultMainSessionKey(defaults);
  const aliases = [
    DEFAULT_MAIN_KEY,
    mainKey,
    DEFAULT_CANONICAL_MAIN_SESSION_KEY,
    defaultMainSessionKey,
    buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey }),
    buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey: DEFAULT_MAIN_KEY }),
    buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey }),
  ].map((entry) => normalizeLowercaseStringOrEmpty(entry));
  if (aliases.includes(normalized)) {
    return normalizeLowercaseStringOrEmpty(defaultMainSessionKey);
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const normalizedAgentId = normalizeLowercaseStringOrEmpty(parsed.agentId);
    const normalizedDefaultAgentId = normalizeLowercaseStringOrEmpty(defaultAgentId);
    if (normalizedAgentId === normalizedDefaultAgentId || normalizedAgentId === DEFAULT_AGENT_ID) {
      return normalizeLowercaseStringOrEmpty(parsed.rest);
    }
  }
  return normalized;
}

export function chatMessageCacheSessionKeysMatch(
  left: string,
  right: string,
  defaults?: ChatMessageCacheSessionDefaults,
): boolean {
  return (
    normalizeChatMessageCacheSessionKey(left, defaults) ===
    normalizeChatMessageCacheSessionKey(right, defaults)
  );
}

export function resolveEquivalentChatMessageCacheKeys(
  sessionKey: string,
  defaults?: ChatMessageCacheSessionDefaults,
): string[] {
  const raw = sessionKey.trim();
  const mainKey = toTrimmedString(defaults?.mainKey) ?? DEFAULT_MAIN_KEY;
  const defaultAgentId = toTrimmedString(defaults?.defaultAgentId) ?? DEFAULT_AGENT_ID;
  const normalized = normalizeChatMessageCacheSessionKey(raw, defaults);
  const defaultMainSessionKey = resolveDefaultMainSessionKey(defaults);
  if (normalized !== normalizeLowercaseStringOrEmpty(defaultMainSessionKey)) {
    const parsed = parseAgentSessionKey(raw);
    if (parsed) {
      const normalizedAgentId = normalizeLowercaseStringOrEmpty(parsed.agentId);
      const normalizedDefaultAgentId = normalizeLowercaseStringOrEmpty(defaultAgentId);
      if (
        normalizedAgentId !== normalizedDefaultAgentId &&
        normalizedAgentId !== DEFAULT_AGENT_ID
      ) {
        return uniqueStrings([raw]);
      }
      return uniqueStrings([
        raw,
        parsed.rest,
        buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey: parsed.rest }),
        buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey: parsed.rest }),
      ]);
    }
    if (normalized.startsWith("agent:")) {
      return uniqueStrings([raw]);
    }
    return uniqueStrings([
      raw,
      buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey: raw }),
      buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey: raw }),
    ]);
  }
  return uniqueStrings([
    raw,
    DEFAULT_MAIN_KEY,
    mainKey,
    DEFAULT_CANONICAL_MAIN_SESSION_KEY,
    defaultMainSessionKey,
    buildAgentMainSessionKey({ agentId: DEFAULT_AGENT_ID, mainKey }),
    buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey: DEFAULT_MAIN_KEY }),
    buildAgentMainSessionKey({ agentId: defaultAgentId, mainKey }),
  ]);
}
