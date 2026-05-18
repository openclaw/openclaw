import path from "node:path";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { normalizeOptionalString, readStringValue } from "../../shared/string-coerce.js";
import { listAgentIds, resolveDefaultAgentId } from "../agent-scope.js";
import { normalizeUserProvidedSessionKey } from "./sessions-key-normalization.js";

export type SafeSessionIndexRow = {
  canonicalKey: string;
  sessionId: string;
  filePath: string;
  label?: string;
  channel?: string;
  updatedAt?: number;
  startedAt?: number;
  endedAt?: number;
};

export type LocalSessionsIndexResult = {
  degraded: true;
  bounded: true;
  source: "local-sessions-index";
  reason?: string;
  limit: number;
  count: number;
  sessions: SafeSessionIndexRow[];
};

export type ExactSessionIndexLookupResult =
  | {
      ok: true;
      row: SafeSessionIndexRow;
      entry: SessionEntry;
      storePath: string;
      agentId: string;
    }
  | { ok: false; error: string };

export const LOCAL_SESSION_INDEX_DEFAULT_LIMIT = 50;
export const LOCAL_SESSION_INDEX_MAX_LIMIT = 100;

function boundedIndexLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return LOCAL_SESSION_INDEX_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(LOCAL_SESSION_INDEX_MAX_LIMIT, Math.floor(limit)));
}

function resolveConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  const agentIds = new Set<string>();
  agentIds.add(normalizeAgentId(resolveDefaultAgentId(cfg)));
  for (const agentId of listAgentIds(cfg)) {
    agentIds.add(normalizeAgentId(agentId));
  }
  return [...agentIds];
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveSafeChannel(params: { key: string; entry: SessionEntry }): string | undefined {
  const direct =
    readStringValue(params.entry.channel) ??
    readStringValue(params.entry.origin?.provider) ??
    readStringValue(params.entry.lastChannel) ??
    readStringValue(params.entry.deliveryContext?.channel);
  if (direct) {
    return direct;
  }
  if (params.key.startsWith("cron:") || params.key.includes(":cron:")) {
    return "internal";
  }
  if (params.key.startsWith("hook:") || params.key.includes(":hook:")) {
    return "internal";
  }
  if (params.key.startsWith("node-") || params.key.startsWith("node:")) {
    return "internal";
  }
  return undefined;
}

function buildSafeSessionIndexRow(params: {
  key: string;
  entry: SessionEntry;
  cfg: OpenClawConfig;
  storePath: string;
  agentId: string;
}): SafeSessionIndexRow | undefined {
  const sessionId = normalizeOptionalString(params.entry.sessionId);
  if (!sessionId) {
    return undefined;
  }
  const canonicalKey = normalizeUserProvidedSessionKey(params.key, {
    defaultAgentId: params.agentId,
  });
  let filePath: string;
  try {
    filePath = resolveSessionFilePath(
      sessionId,
      params.entry,
      resolveSessionFilePathOptions({ agentId: params.agentId, storePath: params.storePath }),
    );
  } catch {
    filePath = path.join(path.dirname(params.storePath), `${sessionId}.jsonl`);
  }
  return {
    canonicalKey,
    sessionId,
    filePath,
    ...(readStringValue(params.entry.label) ? { label: readStringValue(params.entry.label) } : {}),
    ...(resolveSafeChannel({ key: canonicalKey, entry: params.entry })
      ? { channel: resolveSafeChannel({ key: canonicalKey, entry: params.entry }) }
      : {}),
    ...(safeNumber(params.entry.updatedAt) !== undefined
      ? { updatedAt: safeNumber(params.entry.updatedAt) }
      : {}),
    ...(safeNumber(params.entry.startedAt ?? params.entry.sessionStartedAt) !== undefined
      ? { startedAt: safeNumber(params.entry.startedAt ?? params.entry.sessionStartedAt) }
      : {}),
    ...(safeNumber(params.entry.endedAt) !== undefined
      ? { endedAt: safeNumber(params.entry.endedAt) }
      : {}),
  };
}

function readStoreRows(params: {
  cfg: OpenClawConfig;
  agentId: string;
  visit: (key: string, entry: SessionEntry, storePath: string, agentId: string) => void;
}): void {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const store = loadSessionStore(storePath, { skipCache: true });
  for (const [key, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    params.visit(key, entry, storePath, params.agentId);
  }
}

export function isGatewaySessionsListTimeout(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  const nameValue =
    error && typeof error === "object" && "name" in error
      ? (error as { name?: unknown }).name
      : undefined;
  const name = typeof nameValue === "string" ? nameValue.toLowerCase() : "";
  return (
    name === "aborterror" ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("etimedout") ||
    message.includes("deadline")
  );
}

export function buildLocalSessionsIndex(params: {
  cfg: OpenClawConfig;
  limit?: number;
  reason?: string;
  includeAgentIds?: string[];
  filter?: (row: SafeSessionIndexRow, raw: { key: string; entry: SessionEntry }) => boolean;
}): LocalSessionsIndexResult {
  const limit = boundedIndexLimit(params.limit);
  const rows: SafeSessionIndexRow[] = [];
  const agentIds = new Set<string>(resolveConfiguredAgentIds(params.cfg));
  for (const agentId of params.includeAgentIds ?? []) {
    agentIds.add(normalizeAgentId(agentId));
  }

  for (const agentId of agentIds) {
    readStoreRows({
      cfg: params.cfg,
      agentId,
      visit: (key, entry, storePath, storeAgentId) => {
        const row = buildSafeSessionIndexRow({
          key,
          entry,
          cfg: params.cfg,
          storePath,
          agentId: storeAgentId,
        });
        if (!row) {
          return;
        }
        if (params.filter && !params.filter(row, { key, entry })) {
          return;
        }
        rows.push(row);
      },
    });
  }

  rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  return {
    degraded: true,
    bounded: true,
    source: "local-sessions-index",
    ...(params.reason ? { reason: params.reason } : {}),
    limit,
    count: Math.min(rows.length, limit),
    sessions: rows.slice(0, limit),
  };
}

export function lookupExactSessionInLocalIndex(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  defaultAgentId?: string;
}): ExactSessionIndexLookupResult {
  const canonicalKey = normalizeUserProvidedSessionKey(params.sessionKey, {
    defaultAgentId: params.defaultAgentId,
  });
  const parsed = parseAgentSessionKey(canonicalKey);
  const agentId = parsed?.agentId ?? resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath, { skipCache: true });
  const buildLookupResult = (
    candidateKey: string,
    entry: SessionEntry,
  ): ExactSessionIndexLookupResult => {
    const row = buildSafeSessionIndexRow({
      key: candidateKey,
      entry,
      cfg: params.cfg,
      storePath,
      agentId,
    });
    if (!row) {
      return { ok: false, error: `Session has no transcript id: ${canonicalKey}` };
    }
    return { ok: true, row, entry, storePath, agentId };
  };

  const candidates = [canonicalKey, params.sessionKey.trim()].filter(Boolean);
  for (const candidate of candidates) {
    const entry = store[candidate];
    if (!entry) {
      continue;
    }
    return buildLookupResult(candidate, entry);
  }

  for (const [candidateKey, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidateCanonicalKey = normalizeUserProvidedSessionKey(candidateKey, {
      defaultAgentId: agentId,
    });
    if (candidateCanonicalKey !== canonicalKey) {
      continue;
    }
    return buildLookupResult(candidateKey, entry);
  }

  return { ok: false, error: `Session not found in local index: ${canonicalKey}` };
}
