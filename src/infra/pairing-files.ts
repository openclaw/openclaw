import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";
import { readJsonIfExists } from "./json-files.js";

export { createAsyncLock, readJsonIfExists, tryReadJson, writeJson } from "./json-files.js";

const PAIRING_STATE_SCOPE_PREFIX = "pairing";

export function resolvePairingPaths(baseDir: string | undefined, subdir: string) {
  const root = baseDir ?? resolveStateDir();
  const dir = path.join(root, subdir);
  return {
    dir,
    pendingPath: path.join(dir, "pending.json"),
    pairedPath: path.join(dir, "paired.json"),
  };
}

function sqliteOptionsForBaseDir(baseDir: string | undefined): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function pairingStateScope(subdir: string): string {
  return `${PAIRING_STATE_SCOPE_PREFIX}.${subdir}`;
}

export function readPairingStateRecord<T>(params: {
  baseDir?: string;
  subdir: string;
  key: string;
}): Record<string, T> {
  return coercePairingStateRecord<T>(
    readOpenClawStateKvJson(
      pairingStateScope(params.subdir),
      params.key,
      sqliteOptionsForBaseDir(params.baseDir),
    ),
  );
}

export function writePairingStateRecord<T>(params: {
  baseDir?: string;
  subdir: string;
  key: string;
  value: Record<string, T>;
}): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    pairingStateScope(params.subdir),
    params.key,
    params.value as unknown as OpenClawStateJsonValue,
    sqliteOptionsForBaseDir(params.baseDir),
  );
}

export async function legacyPairingStateFilesExist(params: {
  baseDir?: string;
  subdir: string;
}): Promise<boolean> {
  const { pendingPath, pairedPath } = resolvePairingPaths(params.baseDir, params.subdir);
  const [pendingExists, pairedExists] = await Promise.all([
    fs
      .access(pendingPath)
      .then(() => true)
      .catch(() => false),
    fs
      .access(pairedPath)
      .then(() => true)
      .catch(() => false),
  ]);
  return pendingExists || pairedExists;
}

export async function importLegacyPairingStateFilesToSqlite(params: {
  baseDir?: string;
  subdir: string;
}): Promise<{
  pending: number;
  paired: number;
  files: number;
}> {
  const { pendingPath, pairedPath } = resolvePairingPaths(params.baseDir, params.subdir);
  const [pending, paired] = await Promise.all([
    readJsonIfExists<unknown>(pendingPath),
    readJsonIfExists<unknown>(pairedPath),
  ]);
  const pendingRecord = coercePairingStateRecord<unknown>(pending);
  const pairedRecord = coercePairingStateRecord<unknown>(paired);
  let files = 0;
  if (pending !== undefined) {
    writePairingStateRecord({
      baseDir: params.baseDir,
      subdir: params.subdir,
      key: "pending",
      value: pendingRecord,
    });
    await fs.rm(pendingPath, { force: true }).catch(() => undefined);
    files += 1;
  }
  if (paired !== undefined) {
    writePairingStateRecord({
      baseDir: params.baseDir,
      subdir: params.subdir,
      key: "paired",
      value: pairedRecord,
    });
    await fs.rm(pairedPath, { force: true }).catch(() => undefined);
    files += 1;
  }
  return {
    pending: Object.keys(pendingRecord).length,
    paired: Object.keys(pairedRecord).length,
    files,
  };
}

export function coercePairingStateRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, T>;
}

export function pruneExpiredPending<T extends { ts: number }>(
  pendingById: Record<string, T>,
  nowMs: number,
  ttlMs: number,
) {
  for (const [id, req] of Object.entries(pendingById)) {
    if (nowMs - req.ts > ttlMs) {
      delete pendingById[id];
    }
  }
}

export type PendingPairingRequestResult<TPending> = {
  status: "pending";
  request: TPending;
  created: boolean;
};

export async function reconcilePendingPairingRequests<
  TPending extends { requestId: string },
  TIncoming,
>(params: {
  pendingById: Record<string, TPending>;
  existing: readonly TPending[];
  incoming: TIncoming;
  canRefreshSingle: (existing: TPending, incoming: TIncoming) => boolean;
  refreshSingle: (existing: TPending, incoming: TIncoming) => TPending;
  buildReplacement: (params: { existing: readonly TPending[]; incoming: TIncoming }) => TPending;
  persist: () => Promise<void>;
}): Promise<PendingPairingRequestResult<TPending>> {
  if (
    params.existing.length === 1 &&
    params.canRefreshSingle(params.existing[0], params.incoming)
  ) {
    const refreshed = params.refreshSingle(params.existing[0], params.incoming);
    params.pendingById[refreshed.requestId] = refreshed;
    await params.persist();
    return { status: "pending", request: refreshed, created: false };
  }

  for (const existing of params.existing) {
    delete params.pendingById[existing.requestId];
  }

  const request = params.buildReplacement({
    existing: params.existing,
    incoming: params.incoming,
  });
  params.pendingById[request.requestId] = request;
  await params.persist();
  return { status: "pending", request, created: true };
}
