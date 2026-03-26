import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "../../agents/stable-stringify.js";
import * as jsonFiles from "../../infra/json-files.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store-directory");

const DIRECTORY_STORE_NAME = "sessions.d";
const DIRECTORY_STORE_ENTRIES_DIR_NAME = "entries";
const DIRECTORY_STORE_STATE_FILE_NAME = "state.json";
const DIRECTORY_STORE_FILE_PREFIX = "session-";
const DIRECTORY_STORE_HASHED_FILE_PREFIX = "session-hash-";
const DIRECTORY_STORE_FILE_SUFFIX = ".json";
const DIRECTORY_STORE_KIND = "openclaw-session-store-directory";
const DIRECTORY_STORE_LAYOUT_VERSION = 1;
const DIRECTORY_STORE_MAX_INLINE_SESSION_KEY_BYTES = 120;
const LEGACY_SESSION_STORE_MAX_BYTES = 64 * 1024 * 1024;

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

type DirectorySessionEntryDocument = {
  sessionKey: string;
  entry: SessionEntry;
};

type DirectorySessionEntryRecord = {
  sessionKey: string;
  entry: SessionEntry;
};

export type SessionStoreMigrationStatus =
  | "already_directory"
  | "ready_to_migrate"
  | "empty_legacy"
  | "invalid_legacy"
  | "missing";

export type SessionStoreMigrationDetection = {
  storePath: string;
  status: SessionStoreMigrationStatus;
  legacyExists: boolean;
  directoryActive: boolean;
  legacyEntryCount: number;
  normalizedEntryCount: number;
  preview: string[];
  warnings: string[];
};

export type SessionStoreMigrationOutcome =
  | "migrated"
  | "already_directory"
  | "skipped_empty"
  | "skipped_invalid"
  | "failed"
  | "missing";

export type SessionStoreMigrationResult = {
  storePath: string;
  outcome: SessionStoreMigrationOutcome;
  legacyEntries: number;
  migratedEntries: number;
  backupPath?: string;
  warnings: string[];
};

type SessionStoreMigrationInspection =
  | {
      kind: "missing";
      legacyExists: false;
      directoryActive: boolean;
      legacyEntryCount: 0;
      normalizedEntryCount: 0;
      normalizedStore: null;
      warnings: string[];
    }
  | {
      kind: "invalid_legacy";
      legacyExists: true;
      directoryActive: boolean;
      legacyEntryCount: 0;
      normalizedEntryCount: 0;
      normalizedStore: null;
      warnings: string[];
    }
  | {
      kind: "empty_legacy";
      legacyExists: true;
      directoryActive: boolean;
      legacyEntryCount: number;
      normalizedEntryCount: 0;
      normalizedStore: Record<string, SessionEntry>;
      warnings: string[];
    }
  | {
      kind: "ready_to_migrate";
      legacyExists: true;
      directoryActive: boolean;
      legacyEntryCount: number;
      normalizedEntryCount: number;
      normalizedStore: Record<string, SessionEntry>;
      warnings: string[];
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

function normalizeDirectorySessionKey(sessionKey: string): string {
  const normalized = sessionKey.trim();
  if (!normalized) {
    throw new Error("sessionKey must be a non-empty string");
  }
  return normalized;
}

function createSessionKeyDigest(sessionKey: string): string {
  return createHash("sha256").update(sessionKey, "utf8").digest("base64url");
}

function buildDirectorySessionEntryDocument(
  sessionKey: string,
  entry: SessionEntry,
): DirectorySessionEntryDocument {
  return {
    sessionKey,
    entry,
  };
}

function isSessionEntryRecord(value: unknown): value is SessionEntry {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readSessionEntryFile(
  filePath: string,
  expectedSessionKey?: string,
): DirectorySessionEntryRecord | null {
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

    const document = parsed as Partial<DirectorySessionEntryDocument>;
    if (typeof document.sessionKey === "string" && isSessionEntryRecord(document.entry)) {
      const sessionKey = normalizeDirectorySessionKey(document.sessionKey);
      if (expectedSessionKey && expectedSessionKey !== sessionKey) {
        return null;
      }
      return {
        sessionKey,
        entry: document.entry,
      };
    }

    if (!expectedSessionKey || !isSessionEntryRecord(parsed)) {
      return null;
    }

    return {
      sessionKey: expectedSessionKey,
      entry: parsed,
    };
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

async function ensureSafeDirectory(dirPath: string): Promise<string> {
  let stat: fs.Stats;
  try {
    stat = await fsPromises.lstat(dirPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      await fsPromises.mkdir(dirPath, { recursive: true, mode: 0o700 });
      stat = await fsPromises.lstat(dirPath);
    } else {
      throw err;
    }
  }

  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`expected regular directory: ${dirPath}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
    throw new Error(`refusing writable session-store directory: ${dirPath}`);
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(`refusing session-store directory owned by another user: ${dirPath}`);
  }

  return await fsPromises.realpath(dirPath);
}

async function writeDirectoryTextFileAtomic(params: {
  dirPath: string;
  fileName: string;
  content: string;
  mode?: number;
}): Promise<void> {
  const validatedDir = await ensureSafeDirectory(params.dirPath);
  const filePath = path.join(params.dirPath, params.fileName);
  await jsonFiles.writeTextAtomic(filePath, params.content, { mode: params.mode });

  const actualPath = await fsPromises.realpath(filePath).catch(() => null);
  if (!actualPath) {
    throw new Error(`failed to verify directory session store write: ${filePath}`);
  }
  const relativePath = path.relative(validatedDir, actualPath);
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`directory session store write escaped validated directory: ${filePath}`);
  }
}

async function writeDirectoryStoreStateFile(statePath: string, version: number): Promise<void> {
  await writeDirectoryTextFileAtomic({
    dirPath: path.dirname(statePath),
    fileName: path.basename(statePath),
    content: JSON.stringify(buildDirectoryStoreState(version), null, 2),
    mode: 0o600,
  });
}

async function writeDirectorySessionEntryFile(
  entriesDir: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  const normalizedKey = normalizeDirectorySessionKey(sessionKey);
  await writeDirectoryTextFileAtomic({
    dirPath: entriesDir,
    fileName: encodeDirectorySessionStoreKey(normalizedKey),
    content: JSON.stringify(buildDirectorySessionEntryDocument(normalizedKey, entry), null, 2),
    mode: 0o600,
  });
}

async function deleteDirectorySessionEntryFile(
  entriesDir: string,
  sessionKey: string,
): Promise<boolean> {
  await ensureSafeDirectory(entriesDir);
  const filePath = path.join(
    entriesDir,
    encodeDirectorySessionStoreKey(normalizeDirectorySessionKey(sessionKey)),
  );
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

function buildMigrationPreview(params: {
  status: SessionStoreMigrationStatus;
  normalizedEntryCount: number;
}): string[] {
  switch (params.status) {
    case "already_directory":
      return ["Directory-backed session store is already active."];
    case "missing":
      return ["No legacy sessions.json store was found."];
    case "invalid_legacy":
      return ["Legacy sessions.json exists but could not be migrated safely."];
    case "empty_legacy":
      return ["Legacy sessions.json contains no valid session entries to migrate."];
    case "ready_to_migrate":
      return [
        `Legacy sessions.json is ready to migrate (${params.normalizedEntryCount} normalized entries).`,
      ];
  }
}

async function inspectLegacySessionStoreForMigration(params: {
  storePath: string;
  normalizeKey: (sessionKey: string) => string;
  sourceStore?: Record<string, SessionEntry>;
}): Promise<SessionStoreMigrationInspection> {
  const directoryActive = isDirectorySessionStoreActive(params.storePath);
  let sourceStore = params.sourceStore;
  const warnings: string[] = [];

  if (!sourceStore) {
    try {
      const stat = await fsPromises.lstat(params.storePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        warnings.push("Legacy sessions.json is not a regular file.");
        return {
          kind: "invalid_legacy",
          legacyExists: true,
          directoryActive,
          legacyEntryCount: 0,
          normalizedEntryCount: 0,
          normalizedStore: null,
          warnings,
        };
      }
      if (stat.size > LEGACY_SESSION_STORE_MAX_BYTES) {
        warnings.push("Legacy sessions.json exceeds the migration size limit.");
        return {
          kind: "invalid_legacy",
          legacyExists: true,
          directoryActive,
          legacyEntryCount: 0,
          normalizedEntryCount: 0,
          normalizedStore: null,
          warnings,
        };
      }
      const raw = await fsPromises.readFile(params.storePath, "utf-8");
      if (!raw.trim()) {
        return {
          kind: "empty_legacy",
          legacyExists: true,
          directoryActive,
          legacyEntryCount: 0,
          normalizedEntryCount: 0,
          normalizedStore: Object.create(null) as Record<string, SessionEntry>,
          warnings,
        };
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push("Legacy sessions.json does not contain an object store.");
        return {
          kind: "invalid_legacy",
          legacyExists: true,
          directoryActive,
          legacyEntryCount: 0,
          normalizedEntryCount: 0,
          normalizedStore: null,
          warnings,
        };
      }
      sourceStore = parsed as Record<string, SessionEntry>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          kind: "missing",
          legacyExists: false,
          directoryActive,
          legacyEntryCount: 0,
          normalizedEntryCount: 0,
          normalizedStore: null,
          warnings,
        };
      }
      warnings.push(`Failed to parse legacy sessions.json: ${String(err)}`);
      return {
        kind: "invalid_legacy",
        legacyExists: true,
        directoryActive,
        legacyEntryCount: 0,
        normalizedEntryCount: 0,
        normalizedStore: null,
        warnings,
      };
    }
  }

  const legacyEntryCount = Object.keys(sourceStore).length;
  const normalizedStore = normalizeLegacyMigrationStore(sourceStore, params.normalizeKey);
  const normalizedEntryCount = Object.keys(normalizedStore).length;
  if (normalizedEntryCount === 0) {
    return {
      kind: "empty_legacy",
      legacyExists: true,
      directoryActive,
      legacyEntryCount,
      normalizedEntryCount,
      normalizedStore,
      warnings,
    };
  }

  return {
    kind: "ready_to_migrate",
    legacyExists: true,
    directoryActive,
    legacyEntryCount,
    normalizedEntryCount,
    normalizedStore,
    warnings,
  };
}

async function renameLegacyStoreToBackup(storePath: string): Promise<string | undefined> {
  const backupPath = `${storePath}.bak.${Date.now()}`;
  try {
    await fsPromises.rename(storePath, backupPath);
    return backupPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("failed to back up legacy session store after directory migration", {
        storePath,
        error: String(err),
      });
    }
    return undefined;
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
 * Encode a session key into a filesystem-safe filename.
 * Short keys remain reversible; oversized keys switch to a fixed-length hash.
 */
export function encodeDirectorySessionStoreKey(sessionKey: string): string {
  const normalized = normalizeDirectorySessionKey(sessionKey);
  if (Buffer.byteLength(normalized, "utf8") > DIRECTORY_STORE_MAX_INLINE_SESSION_KEY_BYTES) {
    return `${DIRECTORY_STORE_HASHED_FILE_PREFIX}${createSessionKeyDigest(normalized)}${DIRECTORY_STORE_FILE_SUFFIX}`;
  }
  return `${DIRECTORY_STORE_FILE_PREFIX}${Buffer.from(normalized, "utf8").toString("base64url")}${DIRECTORY_STORE_FILE_SUFFIX}`;
}

/**
 * Decode a directory-store entry filename back to its original session key.
 */
export function decodeDirectorySessionStoreEntryFileName(fileName: string): string | null {
  if (
    fileName.startsWith(DIRECTORY_STORE_HASHED_FILE_PREFIX) &&
    fileName.endsWith(DIRECTORY_STORE_FILE_SUFFIX)
  ) {
    return null;
  }
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
} {
  const paths = resolveDirectorySessionStorePaths(params.storePath);
  let lastStore: Record<string, SessionEntry> = Object.create(null) as Record<string, SessionEntry>;

  for (let attempt = 0; attempt < 2; attempt++) {
    const startState = readActiveDirectorySessionStoreState(params.storePath);
    if (!startState) {
      return { store: Object.create(null) as Record<string, SessionEntry> };
    }

    const store: Record<string, SessionEntry> = Object.create(null) as Record<string, SessionEntry>;

    try {
      const entries = fs.readdirSync(paths.entriesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          continue;
        }
        const sessionKeyFromName =
          decodeDirectorySessionStoreEntryFileName(entry.name) ?? undefined;
        const sessionEntry = readSessionEntryFile(
          path.join(paths.entriesDir, entry.name),
          sessionKeyFromName,
        );
        if (!sessionEntry || isBlockedObjectKey(sessionEntry.sessionKey)) {
          continue;
        }
        if (encodeDirectorySessionStoreKey(sessionEntry.sessionKey) !== entry.name) {
          continue;
        }
        store[sessionEntry.sessionKey] = sessionEntry.entry;
      }
    } catch {
      return { store: Object.create(null) as Record<string, SessionEntry> };
    }

    const endState = readActiveDirectorySessionStoreState(params.storePath);
    lastStore = store;
    if (endState && endState.version === startState.version) {
      return { store };
    }
  }

  return { store: lastStore };
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
  return (
    readSessionEntryFile(
      path.join(paths.entriesDir, encodeDirectorySessionStoreKey(params.sessionKey)),
      normalizeDirectorySessionKey(params.sessionKey),
    )?.entry ?? null
  );
}

/**
 * Persist one session entry and bump the store version stamp.
 * Caller must hold the session-store lock for `storePath`.
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
 * Caller must hold the session-store lock for `storePath`.
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
 * Inspect whether a legacy sessions.json store is ready to migrate.
 */
export async function detectSessionStoreMigrationState(params: {
  storePath: string;
  normalizeKey: (sessionKey: string) => string;
  sourceStore?: Record<string, SessionEntry>;
}): Promise<SessionStoreMigrationDetection> {
  const inspection = await inspectLegacySessionStoreForMigration(params);
  const status: SessionStoreMigrationStatus =
    inspection.kind === "missing" && inspection.directoryActive
      ? "already_directory"
      : inspection.kind;
  return {
    storePath: params.storePath,
    status,
    legacyExists: inspection.legacyExists,
    directoryActive: inspection.directoryActive,
    legacyEntryCount: inspection.legacyEntryCount,
    normalizedEntryCount: inspection.normalizedEntryCount,
    preview: buildMigrationPreview({
      status,
      normalizedEntryCount: inspection.normalizedEntryCount,
    }),
    warnings: [...inspection.warnings],
  };
}

/**
 * Crash-safe migration from `sessions.json` to `sessions.d/`.
 */
export async function migrateLegacySessionStoreToDirectory(params: {
  storePath: string;
  normalizeKey: (sessionKey: string) => string;
  sourceStore?: Record<string, SessionEntry>;
}): Promise<SessionStoreMigrationResult> {
  const inspection = await inspectLegacySessionStoreForMigration(params);
  switch (inspection.kind) {
    case "missing":
      return {
        storePath: params.storePath,
        outcome: inspection.directoryActive ? "already_directory" : "missing",
        legacyEntries: 0,
        migratedEntries: 0,
        warnings: [...inspection.warnings],
      };
    case "invalid_legacy":
      return {
        storePath: params.storePath,
        outcome: "skipped_invalid",
        legacyEntries: 0,
        migratedEntries: 0,
        warnings: [...inspection.warnings],
      };
    case "empty_legacy":
      return {
        storePath: params.storePath,
        outcome: "skipped_empty",
        legacyEntries: inspection.legacyEntryCount,
        migratedEntries: 0,
        warnings: [...inspection.warnings],
      };
    case "ready_to_migrate":
      break;
  }

  const normalizedStore = inspection.normalizedStore;
  if (inspection.directoryActive) {
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
    const backupPath = await renameLegacyStoreToBackup(params.storePath);
    return {
      storePath: params.storePath,
      outcome: "migrated",
      legacyEntries: inspection.legacyEntryCount,
      migratedEntries: Object.keys(merged).length,
      backupPath,
      warnings: [...inspection.warnings],
    };
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

  const backupPath = await renameLegacyStoreToBackup(params.storePath);
  return {
    storePath: params.storePath,
    outcome: "migrated",
    legacyEntries: inspection.legacyEntryCount,
    migratedEntries: inspection.normalizedEntryCount,
    backupPath,
    warnings: [...inspection.warnings],
  };
}
