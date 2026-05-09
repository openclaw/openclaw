import fs from "node:fs/promises";
import path from "node:path";
import { CHANNEL_IDS } from "../../../channels/ids.js";
import { getPairingAdapter } from "../../../channels/plugins/pairing.js";
import {
  readAllowFromFileWithExists,
  resolveAllowFromAccountId,
  resolvePairingCredentialsDir,
  safeChannelKey,
  type AllowFromStore,
} from "../../../pairing/allow-from-store-file.js";
import type { PairingChannel } from "../../../pairing/pairing-store.types.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { OpenClawStateDatabaseOptions } from "../../../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../../../state/openclaw-state-kv.js";

const CHANNEL_PAIRING_SCOPE = "pairing.channel";
const LEGACY_PAIRING_SUFFIX = "-pairing.json";
const LEGACY_ALLOW_FROM_SUFFIX = "-allowFrom.json";

type PairingRequest = {
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

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

function normalizePairingRequest(value: unknown): PairingRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<PairingRequest>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.code !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }
  return {
    id: candidate.id,
    code: candidate.code,
    createdAt: candidate.createdAt,
    lastSeenAt:
      typeof candidate.lastSeenAt === "string" ? candidate.lastSeenAt : candidate.createdAt,
    ...(candidate.meta && typeof candidate.meta === "object" && !Array.isArray(candidate.meta)
      ? { meta: candidate.meta }
      : {}),
  };
}

function normalizeAllowEntry(channel: PairingChannel, value: unknown): string {
  const trimmed = String(value).trim();
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
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of Array.isArray(store.allowFrom) ? store.allowFrom : []) {
    const normalized = normalizeAllowEntry(channel, value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
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
    const request = normalizePairingRequest(entry);
    return request ? [request] : [];
  });
  const allowFrom: Record<string, string[]> = {};
  const rawAllowFrom = (record as { allowFrom?: unknown }).allowFrom;
  if (rawAllowFrom && typeof rawAllowFrom === "object" && !Array.isArray(rawAllowFrom)) {
    for (const [accountId, entries] of Object.entries(rawAllowFrom)) {
      allowFrom[resolveAllowFromAccountId(accountId)] = normalizeAllowFromList(channel, {
        version: 1,
        allowFrom: Array.isArray(entries) ? entries.map(String) : [],
      });
    }
  }
  return { version: 1, requests, allowFrom };
}

function readChannelPairingState(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv,
): ChannelPairingState {
  return normalizeChannelPairingState(
    channel,
    readOpenClawStateKvJson(
      CHANNEL_PAIRING_SCOPE,
      safeChannelKey(channel),
      sqliteOptionsForEnv(env),
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
    safeChannelKey(channel),
    {
      version: 1,
      requests: state.requests,
      allowFrom: state.allowFrom ?? {},
    } as OpenClawStateJsonValue,
    sqliteOptionsForEnv(env),
  );
}

export async function legacyChannelPairingFilesExist(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const dir = resolvePairingCredentialsDir(env);
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.some(
    (entry) => entry.endsWith(LEGACY_PAIRING_SUFFIX) || entry.endsWith(LEGACY_ALLOW_FROM_SUFFIX),
  );
}

function parseAllowFromFilename(
  filename: string,
): { channel: PairingChannel; accountId: string } | null {
  if (!filename.endsWith(LEGACY_ALLOW_FROM_SUFFIX)) {
    return null;
  }
  const stem = filename.slice(0, -LEGACY_ALLOW_FROM_SUFFIX.length);
  const knownChannel = [...CHANNEL_IDS]
    .toSorted((left, right) => right.length - left.length)
    .find((channel) => stem === channel || stem.startsWith(`${channel}-`));
  if (!knownChannel) {
    return { channel: stem as PairingChannel, accountId: DEFAULT_ACCOUNT_ID };
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

function parsePairingFilename(filename: string): PairingChannel | null {
  if (!filename.endsWith(LEGACY_PAIRING_SUFFIX)) {
    return null;
  }
  return filename.slice(0, -LEGACY_PAIRING_SUFFIX.length) as PairingChannel;
}

async function readLegacyPairingStore(filePath: string): Promise<PairingStore | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeChannelPairingState("_legacy" as PairingChannel, JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readAllowFromStateForPath(
  channel: PairingChannel,
  filePath: string,
): Promise<string[]> {
  return (
    await readAllowFromFileWithExists({
      cacheNamespace: "pairing-store-legacy-import",
      filePath,
      normalizeStore: (store) => normalizeAllowFromList(channel, store),
    })
  ).entries;
}

export async function importLegacyChannelPairingFilesToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ files: number; requests: number; allowFrom: number }> {
  const dir = resolvePairingCredentialsDir(env);
  const entries = await fs.readdir(dir).catch(() => []);
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
      await fs.rm(filePath, { force: true }).catch(() => undefined);
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
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      files += 1;
    }
  }
  return { files, requests, allowFrom };
}
