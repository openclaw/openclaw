import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeMainKey, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

function resolvePreservedRawExternalStoreKeyCandidate(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
}): string | undefined {
  const key = normalizeSessionKeyPreservingOpaquePeerIds(params.key);
  if (!key || key === params.canonicalKey || !key.includes(":")) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(key);
  const mainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (
    lowered === "global" ||
    lowered === "unknown" ||
    lowered === "main" ||
    lowered === mainKey ||
    lowered.startsWith("agent:") ||
    parseAgentSessionKey(key)
  ) {
    return undefined;
  }
  return key;
}

function resolveAgentSessionRestPreservingSeparators(key: string): string | undefined {
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(key);
  const match = /^agent:([^:]+):(.+)$/.exec(normalized);
  const rest = match?.[2];
  return rest ? rest : undefined;
}

export function resolvePreservedRawExternalStoreKey(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
}): { key: string; preserveMissingAlias: boolean } | undefined {
  const directKey = resolvePreservedRawExternalStoreKeyCandidate(params);
  if (directKey) {
    return { key: directKey, preserveMissingAlias: true };
  }
  const canonicalRest = resolveAgentSessionRestPreservingSeparators(params.canonicalKey);
  if (!canonicalRest) {
    return undefined;
  }
  const canonicalRawKey = resolvePreservedRawExternalStoreKeyCandidate({
    cfg: params.cfg,
    key: canonicalRest,
    canonicalKey: params.canonicalKey,
  });
  return canonicalRawKey ? { key: canonicalRawKey, preserveMissingAlias: false } : undefined;
}

export function normalizeSessionStoreKeys(keys: Iterable<string | undefined>): string[] {
  const normalized = new Set<string>();
  for (const key of keys) {
    const trimmed = normalizeOptionalString(key ?? "") ?? "";
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return Array.from(normalized);
}

export function resolvePreservedRawExternalAliasKeys(params: {
  preservedRawKey: string | undefined;
  preserveMissingAlias: boolean;
  storeKeys: Iterable<string>;
}): string[] {
  if (!params.preservedRawKey) {
    return [];
  }
  const aliases = Array.from(params.storeKeys).filter(
    (key) => normalizeSessionKeyPreservingOpaquePeerIds(key) === params.preservedRawKey,
  );
  if (!params.preserveMissingAlias && aliases.length === 0) {
    return [];
  }
  aliases.push(params.preservedRawKey);
  return normalizeSessionStoreKeys(aliases);
}

export function resolveGatewaySessionStorePreservedAliasKeys(params: {
  cfg: OpenClawConfig;
  key: string;
  canonicalKey: string;
  storeKeys: Iterable<string>;
}): string[] {
  const preservedRaw = resolvePreservedRawExternalStoreKey({
    cfg: params.cfg,
    key: params.key,
    canonicalKey: params.canonicalKey,
  });
  if (!preservedRaw) {
    return [];
  }
  return resolvePreservedRawExternalAliasKeys({
    preservedRawKey: preservedRaw.key,
    preserveMissingAlias: preservedRaw.preserveMissingAlias,
    storeKeys: params.storeKeys,
  });
}

export function syncSessionStoreAliases(params: {
  store: Record<string, SessionEntry>;
  canonicalKey: string;
  entry: SessionEntry;
  aliasKeys: readonly string[];
}): void {
  for (const aliasKey of params.aliasKeys) {
    if (aliasKey !== params.canonicalKey) {
      params.store[aliasKey] = params.entry;
    }
  }
}

export function deleteSessionStoreAliases(params: {
  store: Record<string, SessionEntry>;
  canonicalKey: string;
  aliasKeys: readonly string[];
}): void {
  for (const aliasKey of params.aliasKeys) {
    if (aliasKey !== params.canonicalKey) {
      delete params.store[aliasKey];
    }
  }
}
