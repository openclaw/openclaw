import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "../../agents/stable-stringify.js";
import * as jsonFiles from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store-directory");

const DIRECTORY_STORE_NAME = "sessions.d";
const DIRECTORY_STORE_ENTRIES_DIR_NAME = "entries";
const DIRECTORY_STORE_STATE_FILE_NAME = "state.json";
const DIRECTORY_STORE_FILE_PREFIX = "session-";
const DIRECTORY_STORE_FILE_SUFFIX = ".json";
const DIRECTORY_STORE_KIND = "openclaw-session-store-directory";
const DIRECTORY_STORE_LAYOUT_VERSION = 1;

type DirectorySessionStoreState = {
  kind: typeof DIRECTORY_STORE_KIND;
  layoutVersion: typeof DIRECTORY_STORE_LAYOUT_VERSION;
  version: number;
  updatedAt: number;
};

type DirectorySessionStorePaths = {
  rootDir: string;
  entriesDir: string;
  statePath: string;
};

function isValidStateVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function resolveDirectorySessionStorePaths(storePath: string): DirectorySessionStorePaths {
  const rootDir = path.join(path.dirname(path.resolve(storePath)), DIRECTORY_STORE_NAME);
  return {
    rootDir,
    entriesDir: path.join(rootDir, DIRECTORY_STORE_ENTRIES_DIR_NAME),
    statePath: path.join(rootDir, DIRECTORY_STORE_STATE_FILE_NAME),
  };
}

function readDirectorySessionStoreStateFile(statePath: string): DirectorySessionStoreState | null {
  try {
    const stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return null;
    }
    const parsed = JSON.parse(
      fs.readFileSync(statePath, "utf-8"),
    ) as Partial<DirectorySessionStoreState>;
    if (
      parsed.kind !== DIRECTORY_STORE_KIND ||
      parsed.layoutVersion !== DIRECTORY_STORE_LAYOUT_VERSION ||
      !isValidStateVersion(parsed.version) ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return null;
    }
    return {
      kind: DIRECTORY_STORE_KIND,
      layoutVersion: DIRECTORY_STORE_LAYOUT_VERSION,
      version: parsed.version,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function readActiveDirectorySessionStoreState(
  storePath: string,
): DirectorySessionStoreState | null {
  const paths = resolveDirectorySessionStorePaths(storePath);
  try {
    const rootStat = fs.lstatSync(paths.rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return null;
    }
    const entriesStat = fs.lstatSync(paths.entriesDir);
    if (!entriesStat.isDirectory() || entriesStat.isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  return readDirectorySessionStoreStateFile(paths.statePath);
}

function readSessionEntryFile(filePath: string): SessionEntry | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SessionEntry;
  } catch {
    return null;
  }
}

function buildDirectoryStoreState(version: number): DirectorySessionStoreState {
  return {
    kind: DIRECTORY_STORE_KIND,
    layoutVersion: DIRECTORY_STORE_LAYOUT_VERSION,
    version,
    updatedAt: Date.now(),
  };
}

async function ensureSafeDirectory(dirPath: string): Promise<void> {
  try {
    const stat = await fsPromises.lstat(dirPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`expected regular directory: ${dirPath}`);
    }
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await fsPromises.mkdir(dirPath, { recursive: true, mode: 0o700 });
      return;
    }
    throw err;
  }
}

async function writeDirectoryStoreStateFile(statePath: string, version: number): Promise<void> {
  await jsonFiles.writeTextAtomic(
    statePath,
    JSON.stringify(buildDirectoryStoreState(version), null, 2),
    {
      mode: 0o600,
    },
  );
}

async function writeDirectorySessionEntryFile(
  entriesDir: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  await ensureSafeDirectory(entriesDir);
  const filePath = path.join(entriesDir, encodeDirectorySessionStoreKey(sessionKey));
  await jsonFiles.writeTextAtomic(filePath, JSON.stringify(entry, null, 2), { mode: 0o600 });
}

async function deleteDirectorySessionEntryFile(
  entriesDir: string,
  sessionKey: string,
): Promise<boolean> {
  const filePath = path.join(entriesDir, encodeDirectorySessionStoreKey(sessionKey));
  try {
    const stat = await fsPromises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return false;
    }
    await fsPromises.unlink(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function computeDirectoryStoreDiff(params: {
  previousStore: Record<string, SessionEntry>;
  nextStore: Record<string, SessionEntry>;
}): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [sessionKey, nextEntry] of Object.entries(params.nextStore)) {
    const previousEntry = params.previousStore[sessionKey];
    if (!previousEntry || stableStringify(previousEntry) !== stableStringify(nextEntry)) {
      changed.push(sessionKey);
    }
  }

  for (const sessionKey of Object.keys(params.previousStore)) {
    if (!Object.prototype.hasOwnProperty.call(params.nextStore, sessionKey)) {
      removed.push(sessionKey);
    }
  }

  return { changed, removed };
}

function normalizeLegacyMigrationStore(
  store: Record<string, SessionEntry>,
  normalizeKey: (sessionKey: string) => string,
): Record<string, SessionEntry> {
  const deduped = new Map<string, SessionEntry>();

  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const normalizedKey = normalizeKey(sessionKey);
    if (!normalizedKey) {
      continue;
    }
    const existing = deduped.get(normalizedKey);
    if (!existing || (entry.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
      deduped.set(normalizedKey, entry);
    }
  }

  return Object.fromEntries(deduped);
}

async function renameLegacyStoreToBackup(storePath: string): Promise<void> {
  const backupPath = `${storePath}.bak.${Date.now()}`;
  try {
    await fsPromises.rename(storePath, backupPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("failed to back up legacy session store after directory migration", {
        storePath,
        error: String(err),
      });
    }
  }
}

async function quarantineInactiveDirectoryStore(rootDir: string): Promise<void> {
  try {
    const stat = await fsPromises.lstat(rootDir);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to use symlinked directory session store path: ${rootDir}`);
    }
    const quarantinePath = `${rootDir}.orphan.${Date.now()}`;
    await fsPromises.rename(rootDir, quarantinePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

/**
 * Return the sibling directory that stores per-session entry files.
 */
export function resolveSessionStoreDir(storePath: string): string {
  return resolveDirectorySessionStorePaths(storePath).rootDir;
}

/**
 * Return the state file path used for directory-store cache/version tracking.
 */
export function resolveSessionStoreStatePath(storePath: string): string {
  return resolveDirectorySessionStorePaths(storePath).statePath;
}

/**
 * Encode a session key into a reversible, filesystem-safe filename.
 */
export function encodeDirectorySessionStoreKey(sessionKey: string): string {
  if (!sessionKey.trim()) {
    throw new Error("sessionKey must be a non-empty string");
  }
  return `${DIRECTORY_STORE_FILE_PREFIX}${Buffer.from(sessionKey, "utf8").toString("base64url")}${DIRECTORY_STORE_FILE_SUFFIX}`;
}

/**
 * Decode a directory-store entry filename back to its original session key.
 */
export function decodeDirectorySessionStoreEntryFileName(fileName: string): string | null {
  if (
    fileName.startsWith(".") ||
    !fileName.startsWith(DIRECTORY_STORE_FILE_PREFIX) ||
    !fileName.endsWith(DIRECTORY_STORE_FILE_SUFFIX)
  ) {
    return null;
  }

  const encoded = fileName.slice(
    DIRECTORY_STORE_FILE_PREFIX.length,
    -DIRECTORY_STORE_FILE_SUFFIX.length,
  );
  if (!encoded) {
    return null;
  }

  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (!decoded || encodeDirectorySessionStoreKey(decoded) !== fileName) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Return true when `sessions.d/` is fully initialized and safe to use.
 */
export function isDirectorySessionStoreActive(storePath: string): boolean {
  return readActiveDirectorySessionStoreState(storePath) !== null;
}

/**
 * Return the authoritative directory-store version token when available.
 */
export function readDirectorySessionStoreVersion(storePath: string): string | undefined {
  const state = readActiveDirectorySessionStoreState(storePath);
  return state ? String(state.version) : undefined;
}

/**
 * Load the entire directory-backed session store.
 */
export function loadSessionStoreFromDirectory(params: { storePath: string }): {
  store: Record<string, SessionEntry>;
  versionToken?: string;
} {
  const paths = resolveDirectorySessionStorePaths(params.storePath);
  let lastStore: Record<string, SessionEntry> = {};
  let lastVersionToken: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const startState = readActiveDirectorySessionStoreState(params.storePath);
    if (!startState) {
      return { store: {}, versionToken: undefined };
    }

    const store: Record<string, SessionEntry> = {};
    lastVersionToken = String(startState.version);

    try {
      const entries = fs.readdirSync(paths.entriesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          continue;
        }
        const sessionKey = decodeDirectorySessionStoreEntryFileName(entry.name);
        if (!sessionKey) {
          continue;
        }
        const sessionEntry = readSessionEntryFile(path.join(paths.entriesDir, entry.name));
        if (sessionEntry) {
          store[sessionKey] = sessionEntry;
        }
      }
    } catch {
      return { store: {}, versionToken: undefined };
    }

    const endState = readActiveDirectorySessionStoreState(params.storePath);
    lastStore = store;
    if (endState && endState.version === startState.version) {
      return { store, versionToken: String(endState.version) };
    }
    lastVersionToken = endState ? String(endState.version) : lastVersionToken;
  }

  return { store: lastStore, versionToken: lastVersionToken };
}

/**
 * Read one session entry directly from an active directory-backed store.
 */
export function readSessionEntryFromDirectory(params: {
  storePath: string;
  sessionKey: string;
}): SessionEntry | null {
  if (!isDirectorySessionStoreActive(params.storePath)) {
    return null;
  }
  const paths = resolveDirectorySessionStorePaths(params.storePath);
  return readSessionEntryFile(
    path.join(paths.entriesDir, encodeDirectorySessionStoreKey(params.sessionKey)),
  );
}

/**
 * Persist one session entry and bump the store version stamp.
 */
export async function writeSessionEntryToDirectory(params: {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
}): Promise<void> {
  const paths = resolveDirectorySessionStorePaths(params.storePath);
  const state = readActiveDirectorySessionStoreState(params.storePath);
  if (!state) {
    throw new Error(`directory session store is not active: ${params.storePath}`);
  }
  await writeDirectorySessionEntryFile(paths.entriesDir, params.sessionKey, params.entry);
  await writeDirectoryStoreStateFile(paths.statePath, state.version + 1);
}

/**
 * Remove one session entry from the directory store and bump the store version when changed.
 */
export async function deleteSessionEntryFromDirectory(params: {
  storePath: string;
  sessionKey: string;
}): Promise<boolean> {
  const paths = resolveDirectorySessionStorePaths(params.storePath);
  const state = readActiveDirectorySessionStoreState(params.storePath);
  if (!state) {
    throw new Error(`directory session store is not active: ${params.storePath}`);
  }
  const deleted = await deleteDirectorySessionEntryFile(paths.entriesDir, params.sessionKey);
  if (deleted) {
    await writeDirectoryStoreStateFile(paths.statePath, state.version + 1);
  }
  return deleted;
}

/**
 * Apply a whole-store snapshot into an already-active directory store.
 */
export async function syncDirectorySessionStore(params: {
  storePath: string;
  nextStore: Record<string, SessionEntry>;
  previousStore?: Record<string, SessionEntry>;
}): Promise<boolean> {
  const paths = resolveDirectorySessionStorePaths(params.storePath);
  const state = readActiveDirectorySessionStoreState(params.storePath);
  if (!state) {
    throw new Error(`directory session store is not active: ${params.storePath}`);
  }

  await ensureSafeDirectory(paths.rootDir);
  await ensureSafeDirectory(paths.entriesDir);

  const previousStore =
    params.previousStore ?? loadSessionStoreFromDirectory({ storePath: params.storePath }).store;
  const diff = computeDirectoryStoreDiff({
    previousStore,
    nextStore: params.nextStore,
  });
  if (diff.changed.length === 0 && diff.removed.length === 0) {
    return false;
  }

  for (const sessionKey of diff.changed) {
    await writeDirectorySessionEntryFile(
      paths.entriesDir,
      sessionKey,
      params.nextStore[sessionKey],
    );
  }
  for (const sessionKey of diff.removed) {
    await deleteDirectorySessionEntryFile(paths.entriesDir, sessionKey);
  }

  await writeDirectoryStoreStateFile(paths.statePath, state.version + 1);
  return true;
}

/**
 * Crash-safe migration from `sessions.json` to `sessions.d/`.
 */
export async function migrateLegacySessionStoreToDirectory(params: {
  storePath: string;
  normalizeKey: (sessionKey: string) => string;
  sourceStore?: Record<string, SessionEntry>;
}): Promise<boolean> {
  let sourceStore = params.sourceStore;
  if (!sourceStore) {
    try {
      const raw = await fsPromises.readFile(params.storePath, "utf-8");
      if (!raw.trim()) {
        return false;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return false;
      }
      sourceStore = parsed as Record<string, SessionEntry>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("failed to parse legacy session store during migration", {
          storePath: params.storePath,
          error: String(err),
        });
      }
      return false;
    }
  }

  const normalizedStore = normalizeLegacyMigrationStore(sourceStore, params.normalizeKey);
  if (Object.keys(normalizedStore).length === 0) {
    log.warn("skipping session-store migration because no valid legacy entries were found", {
      storePath: params.storePath,
    });
    return false;
  }

  if (isDirectorySessionStoreActive(params.storePath)) {
    const existing = loadSessionStoreFromDirectory({ storePath: params.storePath }).store;
    const merged: Record<string, SessionEntry> = { ...existing };
    for (const [sessionKey, entry] of Object.entries(normalizedStore)) {
      const existingEntry = merged[sessionKey];
      if (!existingEntry || (entry.updatedAt ?? 0) > (existingEntry.updatedAt ?? 0)) {
        merged[sessionKey] = entry;
      }
    }
    await syncDirectorySessionStore({
      storePath: params.storePath,
      previousStore: existing,
      nextStore: merged,
    });
    await renameLegacyStoreToBackup(params.storePath);
    return true;
  }

  const paths = resolveDirectorySessionStorePaths(params.storePath);
  const stageRoot = `${paths.rootDir}.staging-${process.pid}-${Date.now()}`;
  const stageEntries = path.join(stageRoot, DIRECTORY_STORE_ENTRIES_DIR_NAME);
  const stageStatePath = path.join(stageRoot, DIRECTORY_STORE_STATE_FILE_NAME);

  await fsPromises.rm(stageRoot, { recursive: true, force: true });
  await quarantineInactiveDirectoryStore(paths.rootDir);

  try {
    await ensureSafeDirectory(stageRoot);
    await ensureSafeDirectory(stageEntries);
    for (const [sessionKey, entry] of Object.entries(normalizedStore)) {
      await writeDirectorySessionEntryFile(stageEntries, sessionKey, entry);
    }
    await writeDirectoryStoreStateFile(stageStatePath, 1);
    await fsPromises.rename(stageRoot, paths.rootDir);
  } catch (err) {
    await fsPromises.rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  await renameLegacyStoreToBackup(params.storePath);
  return true;
}
