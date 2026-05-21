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
  return resolvePreservedRawExternalAliasKeys({
    preservedRawKey: preservedRaw?.key,
    preserveMissingAlias: preservedRaw?.preserveMissingAlias === true,
    storeKeys: params.storeKeys,
  });
}

export function syncGatewaySessionStoreAliases(params: {
  store: Record<string, SessionEntry>;
  primaryKey: string;
  aliasKeys: Iterable<string>;
}) {
  const entry = params.store[params.primaryKey];
  if (!entry) {
    return;
  }
  for (const aliasKey of normalizeSessionStoreKeys(params.aliasKeys)) {
    if (aliasKey !== params.primaryKey) {
      params.store[aliasKey] = entry;
    }
  }
}

export function writeGatewaySessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  primaryKey: string;
  aliasKeys: Iterable<string>;
  entry: SessionEntry;
}) {
  params.store[params.primaryKey] = params.entry;
  syncGatewaySessionStoreAliases({
    store: params.store,
    primaryKey: params.primaryKey,
    aliasKeys: params.aliasKeys,
  });
}

export function deleteGatewaySessionStoreEntry(params: {
  store: Record<string, SessionEntry>;
  primaryKey: string;
  aliasKeys: Iterable<string>;
}): boolean {
  let hadEntry = false;
  for (const key of normalizeSessionStoreKeys([params.primaryKey, ...params.aliasKeys])) {
    if (params.store[key]) {
      hadEntry = true;
    }
    delete params.store[key];
  }
  return hadEntry;
}
