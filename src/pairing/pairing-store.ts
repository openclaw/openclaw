import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CHANNEL_IDS } from "../channels/ids.js";
import { getPairingAdapter } from "../channels/plugins/pairing.js";
import type { ChannelPairingAdapter } from "../channels/plugins/pairing.types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import {
  dedupePreserveOrder,
  readAllowFromFileWithExists,
  resolveAllowFromAccountId,
  resolveAllowFromFilePath,
  resolvePairingCredentialsDir,
  safeChannelKey,
  type AllowFromStore,
} from "./allow-from-store-file.js";
import type { PairingChannel } from "./pairing-store.types.js";
export type { PairingChannel } from "./pairing-store.types.js";

type PairingKvRow = {
  value_json?: string;
};

type PairingDatabase = Pick<OpenClawStateKyselyDatabase, "kv">;

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_MAX_ATTEMPTS = 500;
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
const PAIRING_PENDING_MAX = 3;
const CHANNEL_PAIRING_SCOPE = "pairing.channel";
const LEGACY_PAIRING_SUFFIX = "-pairing.json";
const LEGACY_ALLOW_FROM_SUFFIX = "-allowFrom.json";

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

type ChannelPairingState = PairingStore & {
  allowFrom?: Record<string, string[]>;
};

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  return resolveAllowFromFilePath(channel, env, accountId);
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

function resolvePairingRequestAccountId(entry: PairingRequest): string {
  return normalizePairingAccountId(entry.meta?.accountId) || DEFAULT_ACCOUNT_ID;
}

function pruneExcessRequestsByAccount(reqs: PairingRequest[], maxPending: number) {
  if (maxPending <= 0 || reqs.length <= maxPending) {
    return { requests: reqs, removed: false };
  }
  const grouped = new Map<string, number[]>();
  for (const [index, entry] of reqs.entries()) {
    const accountId = resolvePairingRequestAccountId(entry);
    const current = grouped.get(accountId);
    if (current) {
      current.push(index);
      continue;
    }
    grouped.set(accountId, [index]);
  }

  const droppedIndexes = new Set<number>();
  for (const indexes of grouped.values()) {
    if (indexes.length <= maxPending) {
      continue;
    }
    const sortedIndexes = indexes
      .slice()
      .toSorted((left, right) => resolveLastSeenAt(reqs[left]) - resolveLastSeenAt(reqs[right]));
    for (const index of sortedIndexes.slice(0, sortedIndexes.length - maxPending)) {
      droppedIndexes.add(index);
    }
  }
  if (droppedIndexes.size === 0) {
    return { requests: reqs, removed: false };
  }
  return {
    requests: reqs.filter((_, index) => !droppedIndexes.has(index)),
    removed: true,
  };
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
  for (let attempt = 0; attempt < PAIRING_CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = randomCode();
    if (!existing.has(code)) {
      return code;
    }
  }
  throw new Error(
    `failed to generate unique pairing code after ${PAIRING_CODE_MAX_ATTEMPTS} attempts; existing code count: ${existing.size}`,
  );
}

function normalizePairingAccountId(accountId?: string): string {
  return normalizeLowercaseStringOrEmpty(accountId);
}

function requestMatchesAccountId(entry: PairingRequest, normalizedAccountId: string): boolean {
  if (!normalizedAccountId) {
    return true;
  }
  return resolvePairingRequestAccountId(entry) === normalizedAccountId;
}

function normalizeId(value: string | number): string {
  return normalizeStringifiedOptionalString(value) ?? "";
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
  return normalizeOptionalString(normalized) ?? "";
}

function normalizeAllowFromList(channel: PairingChannel, store: AllowFromStore): string[] {
  const list = Array.isArray(store.allowFrom) ? store.allowFrom : [];
  return dedupePreserveOrder(list.map((v) => normalizeAllowEntry(channel, v)).filter(Boolean));
}

function normalizeAllowFromInput(channel: PairingChannel, entry: string | number): string {
  return normalizeAllowEntry(channel, normalizeId(entry));
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
  return await readAllowFromFileWithExists({
    cacheNamespace: "pairing-store-legacy-import",
    filePath,
    normalizeStore: (store) => normalizeAllowFromList(channel, store),
  });
}

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function channelPairingKey(channel: PairingChannel): string {
  return safeChannelKey(channel);
}

function normalizeChannelPairingState(
  channel: PairingChannel,
  value: unknown,
): ChannelPairingState {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawRequests = Array.isArray((record as { requests?: unknown }).requests)
    ? (record as { requests: unknown[] }).requests
    : [];
  const requests = rawRequests.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const candidate = entry as Partial<PairingRequest>;
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.code !== "string" ||
      typeof candidate.createdAt !== "string"
    ) {
      return [];
    }
    return [
      {
        id: candidate.id,
        code: candidate.code,
        createdAt: candidate.createdAt,
        lastSeenAt:
          typeof candidate.lastSeenAt === "string" ? candidate.lastSeenAt : candidate.createdAt,
        ...(candidate.meta && typeof candidate.meta === "object" && !Array.isArray(candidate.meta)
          ? { meta: candidate.meta }
          : {}),
      } satisfies PairingRequest,
    ];
  });
  const allowFrom: Record<string, string[]> = {};
  const rawAllowFrom = (record as { allowFrom?: unknown }).allowFrom;
  if (rawAllowFrom && typeof rawAllowFrom === "object" && !Array.isArray(rawAllowFrom)) {
    for (const [accountId, entries] of Object.entries(rawAllowFrom)) {
      const normalizedAccountId = resolveAllowFromAccountId(accountId);
      allowFrom[normalizedAccountId] = normalizeAllowFromList(channel, {
        version: 1,
        allowFrom: Array.isArray(entries) ? entries.map(String) : [],
      });
    }
  }
  return { version: 1, requests, allowFrom };
}

function readChannelPairingStateFromDatabase(
  database: OpenClawStateDatabase,
  channel: PairingChannel,
): ChannelPairingState {
  const db = getNodeSqliteKysely<PairingDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync<PairingKvRow>(
    database.db,
    db
      .selectFrom("kv")
      .select(["value_json"])
      .where("scope", "=", CHANNEL_PAIRING_SCOPE)
      .where("key", "=", channelPairingKey(channel)),
  );
  if (!row?.value_json) {
    return { version: 1, requests: [], allowFrom: {} };
  }
  try {
    return normalizeChannelPairingState(channel, JSON.parse(row.value_json));
  } catch {
    return { version: 1, requests: [], allowFrom: {} };
  }
}

function readChannelPairingState(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv,
): ChannelPairingState {
  return normalizeChannelPairingState(
    channel,
    readOpenClawStateKvJson(
      CHANNEL_PAIRING_SCOPE,
      channelPairingKey(channel),
      sqliteOptionsForEnv(env),
    ),
  );
}

function writeChannelPairingStateToDatabase(
  database: OpenClawStateDatabase,
  channel: PairingChannel,
  state: ChannelPairingState,
): void {
  const valueJson = JSON.stringify({
    version: 1,
    requests: state.requests,
    allowFrom: state.allowFrom ?? {},
  } satisfies ChannelPairingState);
  const updatedAt = Date.now();
  const db = getNodeSqliteKysely<PairingDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("kv")
      .values({
        scope: CHANNEL_PAIRING_SCOPE,
        key: channelPairingKey(channel),
        value_json: valueJson,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.columns(["scope", "key"]).doUpdateSet({
          value_json: valueJson,
          updated_at: updatedAt,
        }),
      ),
  );
}

function writeChannelPairingState(
  channel: PairingChannel,
  state: ChannelPairingState,
  env: NodeJS.ProcessEnv,
): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    CHANNEL_PAIRING_SCOPE,
    channelPairingKey(channel),
    {
      version: 1,
      requests: state.requests,
      allowFrom: state.allowFrom ?? {},
    } as OpenClawStateJsonValue,
    sqliteOptionsForEnv(env),
  );
}

function readAllowFromState(channel: PairingChannel, env: NodeJS.ProcessEnv, accountId?: string) {
  const resolvedAccountId = resolveAllowFromAccountId(accountId);
  const state = readChannelPairingState(channel, env);
  return (state.allowFrom?.[resolvedAccountId] ?? []).slice();
}

async function updateAllowFromStoreEntry(params: {
  channel: PairingChannel;
  entry: string | number;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  apply: (current: string[], normalized: string) => string[] | null;
}): Promise<{ changed: boolean; allowFrom: string[] }> {
  const env = params.env ?? process.env;
  const normalizedAccountId = resolveAllowFromAccountId(params.accountId);
  const normalized = normalizeAllowFromInput(params.channel, params.entry);
  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    const current = (state.allowFrom?.[normalizedAccountId] ?? []).slice();
    if (!normalized) {
      return { changed: false, allowFrom: current };
    }
    const next = params.apply(current, normalized);
    if (!next) {
      return { changed: false, allowFrom: current };
    }
    state.allowFrom ??= {};
    state.allowFrom[normalizedAccountId] = next;
    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { changed: true, allowFrom: next };
  }, sqliteOptionsForEnv(env));
}

export async function readLegacyChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return readAllowFromState(channel, env, DEFAULT_ACCOUNT_ID);
}

export async function readChannelAllowFromStore(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): Promise<string[]> {
  return readAllowFromState(channel, env, accountId);
}

export function readLegacyChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return readAllowFromState(channel, env, DEFAULT_ACCOUNT_ID);
}

export function readChannelAllowFromStoreSync(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string[] {
  return readAllowFromState(channel, env, accountId);
}

export function clearPairingAllowFromReadCacheForTest(): void {
  // Runtime allowFrom reads are SQLite-backed; legacy import helpers still keep
  // their own file-read caches and are cleared by tests through that module.
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
  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, channel);
    const { requests: prunedExpired, removed: expiredRemoved } = pruneExpiredRequests(
      state.requests,
      Date.now(),
    );
    const { requests: pruned, removed: cappedRemoved } = pruneExcessRequestsByAccount(
      prunedExpired,
      PAIRING_PENDING_MAX,
    );
    if (expiredRemoved || cappedRemoved) {
      state.requests = pruned;
      writeChannelPairingStateToDatabase(database, channel, state);
    }
    const normalizedAccountId = normalizePairingAccountId(accountId);
    const filtered = normalizedAccountId
      ? pruned.filter((entry) => requestMatchesAccountId(entry, normalizedAccountId))
      : pruned;
    return filtered.slice().toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, sqliteOptionsForEnv(env));
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
  return runOpenClawStateWriteTransaction((database) => {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const id = normalizeId(params.id);
    const normalizedAccountId = normalizePairingAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
    const baseMeta =
      params.meta && typeof params.meta === "object"
        ? Object.fromEntries(
            Object.entries(params.meta)
              .map(([k, v]) => [k, normalizeOptionalString(v) ?? ""] as const)
              .filter(([_, v]) => Boolean(v)),
          )
        : undefined;
    const meta = { ...baseMeta, accountId: normalizedAccountId };

    const state = readChannelPairingStateFromDatabase(database, params.channel);
    let reqs = state.requests;
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
      reqs.map((req) => (normalizeOptionalString(req.code) ?? "").toUpperCase()),
    );

    if (existingIdx >= 0) {
      const existing = reqs[existingIdx];
      const existingCode = normalizeOptionalString(existing?.code) ?? "";
      const code = existingCode || generateUniqueCode(existingCodes);
      const next: PairingRequest = {
        id,
        code,
        createdAt: existing?.createdAt ?? now,
        lastSeenAt: now,
        meta: meta ?? existing?.meta,
      };
      reqs[existingIdx] = next;
      const { requests: capped } = pruneExcessRequestsByAccount(reqs, PAIRING_PENDING_MAX);
      state.requests = capped;
      writeChannelPairingStateToDatabase(database, params.channel, state);
      return { code, created: false };
    }

    const { requests: capped, removed: cappedRemoved } = pruneExcessRequestsByAccount(
      reqs,
      PAIRING_PENDING_MAX,
    );
    reqs = capped;
    const accountRequestCount = reqs.filter((r) =>
      requestMatchesAccountId(r, normalizedMatchingAccountId),
    ).length;
    if (PAIRING_PENDING_MAX > 0 && accountRequestCount >= PAIRING_PENDING_MAX) {
      if (expiredRemoved || cappedRemoved) {
        state.requests = reqs;
        writeChannelPairingStateToDatabase(database, params.channel, state);
      }
      return { code: "", created: false };
    }
    const code = generateUniqueCode(existingCodes);
    const next: PairingRequest = {
      id,
      code,
      createdAt: now,
      lastSeenAt: now,
      ...(meta ? { meta } : {}),
    };
    state.requests = [...reqs, next];
    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { code, created: true };
  }, sqliteOptionsForEnv(env));
}

export async function approveChannelPairingCode(params: {
  channel: PairingChannel;
  code: string;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ id: string; entry?: PairingRequest } | null> {
  const env = params.env ?? process.env;
  const code = (normalizeNullableString(params.code) ?? "").toUpperCase();
  if (!code) {
    return null;
  }

  return runOpenClawStateWriteTransaction((database) => {
    const state = readChannelPairingStateFromDatabase(database, params.channel);
    const { requests: pruned, removed } = pruneExpiredRequests(state.requests, Date.now());
    const normalizedAccountId = normalizePairingAccountId(params.accountId);
    const idx = pruned.findIndex((r) => {
      if (r.code.toUpperCase() !== code) {
        return false;
      }
      return requestMatchesAccountId(r, normalizedAccountId);
    });
    if (idx < 0) {
      if (removed) {
        state.requests = pruned;
        writeChannelPairingStateToDatabase(database, params.channel, state);
      }
      return null;
    }
    const entry = pruned[idx];
    if (!entry) {
      return null;
    }
    pruned.splice(idx, 1);
    state.requests = pruned;
    const entryAccountId = normalizeOptionalString(entry.meta?.accountId);
    const allowAccountId = resolveAllowFromAccountId(
      normalizeOptionalString(params.accountId) ?? entryAccountId,
    );
    const currentAllow = state.allowFrom?.[allowAccountId] ?? [];
    const normalizedAllow = normalizeAllowFromInput(params.channel, entry.id);
    if (normalizedAllow && !currentAllow.includes(normalizedAllow)) {
      state.allowFrom ??= {};
      state.allowFrom[allowAccountId] = [...currentAllow, normalizedAllow];
    }
    writeChannelPairingStateToDatabase(database, params.channel, state);
    return { id: entry.id, entry };
  }, sqliteOptionsForEnv(env));
}

export async function legacyChannelPairingFilesExist(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const dir = resolvePairingCredentialsDir(env);
  const entries = await fs.promises.readdir(dir).catch(() => []);
  return entries.some(
    (entry) => entry.endsWith(LEGACY_PAIRING_SUFFIX) || entry.endsWith(LEGACY_ALLOW_FROM_SUFFIX),
  );
}

function parseAllowFromFilename(filename: string): { channel: string; accountId: string } | null {
  if (!filename.endsWith(LEGACY_ALLOW_FROM_SUFFIX)) {
    return null;
  }
  const stem = filename.slice(0, -LEGACY_ALLOW_FROM_SUFFIX.length);
  const knownChannel = [...CHANNEL_IDS]
    .toSorted((left, right) => right.length - left.length)
    .find((channel) => stem === channel || stem.startsWith(`${channel}-`));
  if (!knownChannel) {
    return { channel: stem, accountId: DEFAULT_ACCOUNT_ID };
  }
  if (stem === knownChannel) {
    return { channel: knownChannel, accountId: DEFAULT_ACCOUNT_ID };
  }
  const accountId = stem.slice(knownChannel.length + 1);
  return {
    channel: knownChannel,
    accountId: accountId || DEFAULT_ACCOUNT_ID,
  };
}

function parsePairingFilename(filename: string): string | null {
  if (!filename.endsWith(LEGACY_PAIRING_SUFFIX)) {
    return null;
  }
  return filename.slice(0, -LEGACY_PAIRING_SUFFIX.length);
}

async function readLegacyPairingStore(filePath: string): Promise<PairingStore | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as PairingStore;
    return {
      version: 1,
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
    };
  } catch {
    return null;
  }
}

export async function importLegacyChannelPairingFilesToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ files: number; requests: number; allowFrom: number }> {
  const dir = resolvePairingCredentialsDir(env);
  const entries = await fs.promises.readdir(dir).catch(() => []);
  let files = 0;
  let requests = 0;
  let allowFrom = 0;
  for (const filename of entries) {
    const filePath = path.join(dir, filename);
    const pairingChannel = parsePairingFilename(filename);
    if (pairingChannel) {
      const legacy = await readLegacyPairingStore(filePath);
      if (legacy) {
        const state = readChannelPairingState(pairingChannel, env);
        state.requests = legacy.requests;
        writeChannelPairingState(pairingChannel, state, env);
        requests += legacy.requests.length;
      }
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      files += 1;
      continue;
    }

    const allowFromTarget = parseAllowFromFilename(filename);
    if (allowFromTarget) {
      const entries = await readAllowFromStateForPath(allowFromTarget.channel, filePath);
      const state = readChannelPairingState(allowFromTarget.channel, env);
      state.allowFrom ??= {};
      state.allowFrom[resolveAllowFromAccountId(allowFromTarget.accountId)] = entries;
      writeChannelPairingState(allowFromTarget.channel, state, env);
      allowFrom += entries.length;
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      files += 1;
    }
  }
  return { files, requests, allowFrom };
}
