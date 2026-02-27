import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { ChannelId, ChannelPairingAdapter } from "../channels/plugins/types.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { getDatastore } from "../infra/datastore.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
const PAIRING_PENDING_MAX = 3;
export type PairingChannel = ChannelId;

export type PairingRequest = {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
};

type PairingStore = {
  version: 1;
  requests: PairingRequest[];
};

type AllowFromStore = {
  version: 1;
  allowFrom: string[];
};

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return resolveOAuthDir(env, stateDir);
}

/** Sanitize channel ID for use in filenames (prevent path traversal). */
function safeChannelKey(channel: PairingChannel): string {
  const raw = String(channel).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid pairing channel");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing channel");
  }
  return safe;
}

function resolvePairingPath(channel: PairingChannel, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCredentialsDir(env), `${safeChannelKey(channel)}-pairing.json`);
}

function safeAccountKey(accountId: string): string {
  const raw = String(accountId).trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid pairing account id");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid pairing account id");
  }
  return safe;
}

function resolveAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  const base = safeChannelKey(channel);
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (!normalizedAccountId) {
    return path.join(resolveCredentialsDir(env), `${base}-allowFrom.json`);
  }
  return path.join(
    resolveCredentialsDir(env),
    `${base}-${safeAccountKey(normalizedAccountId)}-allowFrom.json`,
  );
}

async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  return getDatastore().readWithFallback(filePath, fallback);
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function isExpired(entry: PairingRequest, nowMs: number): boolean {
  const createdAt = parseTimestamp(entry.createdAt);
  if (!createdAt) {
    return true;
  }
  return nowMs - createdAt > PAIRING_PENDING_TTL_MS;
}

function pruneExpiredRequests(reqs: PairingRequest[], nowMs: number) {
  const kept: PairingRequest[] = [];
  let removed = false;
  for (const req of reqs) {
    if (isExpired(req, nowMs)) {
      removed = true;
      continue;
    }
    kept.push(req);
  }
  return { requests: kept, removed };
}

function resolveLastSeenAt(entry: PairingRequest): number {
  return parseTimestamp(entry.lastSeenAt) ?? parseTimestamp(entry.createdAt) ?? 0;
}

function pruneExcessRequests(reqs: PairingRequest[], maxPending: number) {
  if (maxPending <= 0 || reqs.length <= maxPending) {
    return { requests: reqs, removed: false };
  }
  const sorted = reqs.slice().toSorted((a, b) => resolveLastSeenAt(a) - resolveLastSeenAt(b));
  return { requests: sorted.slice(-maxPending), removed: true };
}

function randomCode(): string {
  // Human-friendly: 8 chars, upper, no ambiguous chars (0O1I).
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    const idx = crypto.randomInt(0, PAIRING_CODE_ALPHABET.length);
    out += PAIRING_CODE_ALPHABET[idx];
  }
  return out;
}

function generateUniqueCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error("failed to generate unique pairing code");
}

function normalizePairingAccountId(accountId?: string): string {
  return accountId?.trim().toLowerCase() || "";
}

function requestMatchesAccountId(entry: PairingRequest, normalizedAccountId: string): boolean {
  if (!normalizedAccountId) {
    return true;
  }
  return (
    String(entry.meta?.accountId ?? "")
      .trim()
      .toLowerCase() === normalizedAccountId
  );
}

function shouldIncludeLegacyAllowFromEntries(normalizedAccountId: string): boolean {
  // Keep backward compatibility for legacy channel-scoped allowFrom only on default account.
  // Non-default accounts should remain isolated to avoid cross-account implicit approvals.
  return !normalizedAccountId || normalizedAccountId === DEFAULT_ACCOUNT_ID;
}

function normalizeId(value: string | number): string {
  return String(value).trim();
}

function normalizeAllowEntry(channel: PairingChannel, entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "";
  }
  const adapter = getPairingAdapter(channel);
  const normalized = adapter?.normalizeAllowEntry ? adapter.normalizeAllowEntry(trimmed) : trimmed;
  return String(normalized).trim();
}

function normalizeAllowFromList(channel: PairingChannel, store: AllowFromStore): string[] {
  const list = Array.isArray(store.allowFrom) ? store.allowFrom : [];
  return dedupePreserveOrder(
    list.map((v) => normalizeAllowEntry(channel, String(v))).filter(Boolean),
  );
}

function normalizeAllowFromInput(channel: PairingChannel, entry: string | number): string {
  return normalizeAllowEntry(channel, normalizeId(entry));
}

function dedupePreserveOrder(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    const normalized = String(entry).trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function readAllowFromStateForPath(
  channel: PairingChannel,
  filePath: string,
): Promise<string[]> {
  return (await readAllowFromStateForPathWithExists(channel, filePath)).entries;
}

async function readAllowFromStateForPathWithExists(
  channel: PairingChannel,
  filePath: string,
): Promise<{ entries: string[]; exists: boolean }> {
  const { value, exists } = await readJsonFile<AllowFromStore>(filePath, {
    version: 1,
    allowFrom: [],
  });
  const entries = normalizeAllowFromList(channel, value);
  return { entries, exists };
}

function readAllowFromStateForPathSync(channel: PairingChannel, filePath: string): string[] {
  return readAllowFromStateForPathSyncWithExists(channel, filePath).entries;
}

function readAllowFromStateForPathSyncWithExists(
  channel: PairingChannel,
  filePath: string,
): { entries: string[]; exists: boolean } {
  const data = getDatastore().read<AllowFromStore>(filePath);
  if (data == null) {
    return { entries: [], exists: false };
  }
  const entries = normalizeAllowFromList(channel, data);
  return { entries, exists: true };
}

async function readNonDefaultAccountAllowFrom(params: {
  channel: PairingChannel;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): Promise<string[]> {
  const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
  return await readAllowFromStateForPath(params.channel, scopedPath);
}

function readNonDefaultAccountAllowFromSync(params: {
  channel: PairingChannel;
  env: NodeJS.ProcessEnv;
  accountId: string;
}): string[] {
  const scopedPath = resolveAllowFromPath(params.channel, params.env, params.accountId);
  return readAllowFromStateForPathSync(params.channel, scopedPath);
}

async function updateAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  apply: (current: string[], normalized: string) => string[] | null;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  const env = params.env ?? process.env;
  const filePath = resolveAllowFromPath(params.channel, env, params.accountId);
  let result: { changed: boolean; allowFrom: string[] } = { changed: false, allowFrom: [] };
  await getDatastore().updateWithLock<AllowFromStore>(filePath, (raw) => {
    const store = raw ?? { version: 1, allowFrom: [] };
    const current = normalizeAllowFromList(params.channel, store);
    const normalized = normalizeAllowFromInput(params.channel, params.entry);
    if (!normalized) {
      result = { changed: false, allowFrom: current };
      return { changed: false, result: store };
    }
    const next = params.apply(current, normalized);
    if (!next) {
      result = { changed: false, allowFrom: current };
      return { changed: false, result: store };
    }
    result = { changed: true, allowFrom: next };
    return { changed: true, result: { version: 1, allowFrom: next } satisfies AllowFromStore };
  });
  return result;
}

export async function readLegacyChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const filePath = resolveAllowFromPath(channel, env);
  return await readAllowFromStateForPath(channel, filePath);
}

export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
): Promise<string[]> {
  const normalizedAccountId = accountId.trim().toLowerCase();
  const resolvedAccountId = normalizedAccountId || DEFAULT_ACCOUNT_ID;

  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    return await readNonDefaultAccountAllowFrom({
      channel,
      env,
      accountId: resolvedAccountId,
    });
  }
  const scopedPath = resolveAllowFromPath(channel, env, resolvedAccountId);
  const scopedEntries = await readAllowFromStateForPath(channel, scopedPath);
  // Backward compatibility: legacy channel-level allowFrom store was unscoped.
  // Keep honoring it for default account to prevent re-pair prompts after upgrades.
  const legacyPath = resolveAllowFromPath(channel, env);
  const legacyEntries = await readAllowFromStateForPath(channel, legacyPath);
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

export function readLegacyChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const filePath = resolveAllowFromPath(channel, env);
  return readAllowFromStateForPathSync(channel, filePath);
}

export function readChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId: string,
): string[] {
  const normalizedAccountId = accountId.trim().toLowerCase();
  const resolvedAccountId = normalizedAccountId || DEFAULT_ACCOUNT_ID;

  if (!shouldIncludeLegacyAllowFromEntries(resolvedAccountId)) {
    return readNonDefaultAccountAllowFromSync({
      channel,
      env,
      accountId: resolvedAccountId,
    });
  }
  const scopedPath = resolveAllowFromPath(channel, env, resolvedAccountId);
  const scopedEntries = readAllowFromStateForPathSync(channel, scopedPath);
  const legacyPath = resolveAllowFromPath(channel, env);
  const legacyEntries = readAllowFromStateForPathSync(channel, legacyPath);
  return dedupePreserveOrder([...scopedEntries, ...legacyEntries]);
}

type AllowFromStoreEntryUpdateParams = {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
};

type ChannelAllowFromStoreEntryMutation = (
  current: string[],
  normalized: string,
) => string[] | null;

async function updateChannelAllowFromStore(
  params: {
    apply: ChannelAllowFromStoreEntryMutation;
  } & AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await updateAllowFromStoreEntry({
    channel: params.channel,
    entry: params.entry,
    accountId: params.accountId,
    env: params.env,
    apply: params.apply,
  });
}

async function mutateChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
  apply: ChannelAllowFromStoreEntryMutation,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await updateChannelAllowFromStore({
    ...params,
    apply,
  });
}

export async function addChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
    if (current.includes(normalized)) {
      return null;
    }
    return [...current, normalized];
  });
}

export async function removeChannelAllowFromStoreEntry(
  params: AllowFromStoreEntryUpdateParams,
): Promise<{ changed: boolean; allowFrom: string[] }> {
  return await mutateChannelAllowFromStoreEntry(params, (current, normalized) => {
    const next = current.filter((entry) => entry !== normalized);
    if (next.length === current.length) {
      return null;
    }
    return next;
  });
}

export async function listChannelPairingRequests(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<PairingRequest[]> {
  const filePath = resolvePairingPath(channel, env);
  let resultRequests: PairingRequest[] = [];
  await getDatastore().updateWithLock<PairingStore>(filePath, (raw) => {
    const store = raw ?? { version: 1, requests: [] };
    const reqs = Array.isArray(store.requests) ? store.requests : [];
    const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(
      reqs,
      Date.now(),
    );
    const { requests: pruned, removed: cappedRemoved } = pruneExcessRequests(
      prunedExpired,
      PAIRING_PENDING_MAX,
    );
    const normalizedAccountId = normalizePairingAccountId(accountId);
    const filtered = normalizedAccountId
      ? pruned.filter((entry) => requestMatchesAccountId(entry, normalizedAccountId))
      : pruned;
    resultRequests = filtered
      .filter(
        (r) =>
          r &&
          typeof r.id === "string" &&
          typeof r.code === "string" &&
          typeof r.createdAt === "string",
      )
      .slice()
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
    const changed = expiredRemoved || cappedRemoved;
    return { changed, result: { version: 1, requests: pruned } };
  });
  return resultRequests;
}

export async function upsertChannelPairingRequest(params: {
  channel: PairingChannel;
  id: string | number;
  accountId: string;
  meta?: Record<string, string | undefined | null>;
  env?: NodeJS.ProcessEnv;
  /** Extension channels can pass their adapter directly to bypass registry lookup. */
  pairingAdapter?: ChannelPairingAdapter;
}): Promise<{ code: string; created: boolean }> {
  const env = params.env ?? process.env;
  const filePath = resolvePairingPath(params.channel, env);
  let upsertResult: { code: string; created: boolean } = { code: "", created: false };
  await getDatastore().updateWithLock<PairingStore>(filePath, (raw) => {
    const store = raw ?? { version: 1, requests: [] };
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const id = normalizeId(params.id);
    const normalizedAccountId = normalizePairingAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
    const baseMeta =
      params.meta && typeof params.meta === "object"
        ? Object.fromEntries(
            Object.entries(params.meta)
              .map(([k, v]) => [k, String(v ?? "").trim()] as const)
              .filter(([_, v]) => Boolean(v)),
          )
        : undefined;
    const meta = { ...baseMeta, accountId: normalizedAccountId };

    let reqs = Array.isArray(store.requests) ? store.requests : [];
    const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(reqs, nowMs);
    reqs = prunedExpired;
    const normalizedMatchingAccountId = normalizedAccountId;
    const existingIdx = reqs.findIndex((r) => {
      if (r.id !== id) {
        return false;
      }
      return requestMatchesAccountId(r, normalizedMatchingAccountId);
    });
    const existingCodes = new Set(
      reqs.map((req) =>
        String(req.code ?? "")
          .trim()
          .toUpperCase(),
      ),
    );

    if (existingIdx >= 0) {
      const existing = reqs[existingIdx];
      const existingCode =
        existing && typeof existing.code === "string" ? existing.code.trim() : "";
      const code = existingCode || generateUniqueCode(existingCodes);
      const next: PairingRequest = {
        id,
        code,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
        meta: meta ?? existing?.meta,
      };
      reqs[existingIdx] = next;
      const { requests: capped } = pruneExcessRequests(reqs, PAIRING_PENDING_MAX);
      upsertResult = { code, created: false };
      return { changed: true, result: { version: 1, requests: capped } };
    }

    const { requests: capped, removed: cappedRemoved } = pruneExcessRequests(
      reqs,
      PAIRING_PENDING_MAX,
    );
    reqs = capped;
    if (PAIRING_PENDING_MAX > 0 && reqs.length >= PAIRING_PENDING_MAX) {
      upsertResult = { code: "", created: false };
      return { changed: expiredRemoved || cappedRemoved, result: { version: 1, requests: reqs } };
    }
    const code = generateUniqueCode(existingCodes);
    const next: PairingRequest = {
      id,
      code,
      createdAt: now,
      lastSeenAt: now,
      ...(meta ? { meta } : {}),
    };
    upsertResult = { code, created: true };
    return { changed: true, result: { version: 1, requests: [...reqs, next] } };
  });
  return upsertResult;
}

export async function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry?: PairingRequest } | null> {
  const env = params.env ?? process.env;
  const code = params.code.trim().toUpperCase();
  if (!code) {
    return null;
  }

  const filePath = resolvePairingPath(params.channel, env);
  let approvedEntry: PairingRequest | null = null;
  await getDatastore().updateWithLock<PairingStore>(filePath, (raw) => {
    const store = raw ?? { version: 1, requests: [] };
    const reqs = Array.isArray(store.requests) ? store.requests : [];
    const { requests: pruned, removed } = pruneExpiredRequests(reqs, Date.now());
    const normalizedAccountId = normalizePairingAccountId(params.accountId);
    const idx = pruned.findIndex((r) => {
      if (String(r.code ?? "").toUpperCase() !== code) {
        return false;
      }
      return requestMatchesAccountId(r, normalizedAccountId);
    });
    if (idx < 0) {
      approvedEntry = null;
      return { changed: removed, result: { version: 1, requests: pruned } };
    }
    const entry = pruned[idx];
    if (!entry) {
      approvedEntry = null;
      return { changed: removed, result: { version: 1, requests: pruned } };
    }
    approvedEntry = entry;
    pruned.splice(idx, 1);
    return { changed: true, result: { version: 1, requests: pruned } };
  });

  // addChannelAllowFromStoreEntry is async and uses its own lock, so it runs
  // after the pairing-store lock is released.
  const approved = approvedEntry as PairingRequest | null;
  if (!approved) {
    return null;
  }
  const entryAccountId = String(approved.meta?.accountId ?? "").trim() || undefined;
  await addChannelAllowFromStoreEntry({
    channel: params.channel,
    entry: approved.id,
    accountId: params.accountId?.trim() || entryAccountId,
    env,
  });
  return { id: approved.id, entry: approved };
}
