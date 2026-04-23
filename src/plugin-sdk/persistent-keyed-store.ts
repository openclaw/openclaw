import fs from "node:fs/promises";
import path from "node:path";
import { resolveProcessScopedMap } from "../shared/process-scoped-map.js";
import type { FileLockOptions } from "./file-lock.js";
import { withFileLock } from "./file-lock.js";
import { writeJsonFileAtomically } from "./json-store.js";
import { resolveStateDir } from "./state-paths.js";

const STORE_VERSION = 1;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const ACCESS_QUEUE_KEY = Symbol.for("openclaw.persistentKeyedStoreAccessQueues");
const ACCESS_QUEUES = resolveProcessScopedMap<Promise<unknown>>(ACCESS_QUEUE_KEY);

const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

interface StoredEntry<T> {
  record: T;
  createdAt: number;
  expiresAt?: number;
}

interface Envelope<T> {
  version: number;
  entries: Record<string, StoredEntry<T>>;
}

type PersistentKeyedStoreLogger = {
  warn: (message: string, meta?: unknown) => void;
};

type ReadEnvelopeResult<T> =
  | { kind: "missing" }
  | { kind: "ok"; envelope: Envelope<T> }
  | {
      kind: "quarantine";
      versionLabel: string;
      reason: "corrupt" | "version-mismatch";
      version?: number;
    };

export interface PersistentKeyedStoreOptions {
  namespace: string;
  stateDir?: string;
  defaultTtlMs?: number;
  maxEntries: number;
  lockOptions?: Partial<FileLockOptions>;
  logger?: PersistentKeyedStoreLogger;
}

export interface PersistentKeyedStoreEntry<T> {
  id: string;
  record: T;
  createdAt: number;
  expiresAt?: number;
}

export interface PersistentKeyedStore<T> {
  register(id: string, record: T, options?: { ttlMs?: number }): Promise<void>;
  lookup(id: string): Promise<T | undefined>;
  consume(id: string): Promise<T | undefined>;
  entries(): Promise<PersistentKeyedStoreEntry<T>[]>;
  clear(): Promise<void>;
}

function mergeLockOptions(overrides?: Partial<FileLockOptions>): FileLockOptions {
  return {
    stale: overrides?.stale ?? DEFAULT_LOCK_OPTIONS.stale,
    retries: {
      retries: overrides?.retries?.retries ?? DEFAULT_LOCK_OPTIONS.retries.retries,
      factor: overrides?.retries?.factor ?? DEFAULT_LOCK_OPTIONS.retries.factor,
      minTimeout: overrides?.retries?.minTimeout ?? DEFAULT_LOCK_OPTIONS.retries.minTimeout,
      maxTimeout: overrides?.retries?.maxTimeout ?? DEFAULT_LOCK_OPTIONS.retries.maxTimeout,
      randomize: overrides?.retries?.randomize ?? DEFAULT_LOCK_OPTIONS.retries.randomize,
    },
  };
}

function createEmptyEnvelope<T>(): Envelope<T> {
  return {
    version: STORE_VERSION,
    entries: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateNamespace(value: string): string {
  const trimmed = value.trim();
  if (!NAMESPACE_PATTERN.test(trimmed)) {
    throw new Error(
      `persistent-keyed-store namespace must be a single safe path segment: ${value}`,
    );
  }
  return trimmed;
}

function validateId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("persistent-keyed-store id must not be empty");
  }
  return trimmed;
}

function validateOptionalTtlMs(value: number | undefined, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`persistent-keyed-store ${label} must be an integer >= 0`);
  }
  return value;
}

function validateMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("persistent-keyed-store maxEntries must be an integer >= 1");
  }
  return value;
}

function resolveStoreFilePath(namespace: string, stateDir?: string): string {
  const trimmedStateDir = stateDir?.trim();
  if (stateDir != null && !trimmedStateDir) {
    throw new Error("persistent-keyed-store stateDir must not be empty when provided");
  }
  const root = trimmedStateDir ? path.resolve(trimmedStateDir) : resolveStateDir(process.env);
  return path.resolve(root, "lifecycle", namespace, "store.json");
}

function serializeEnvelope<T>(envelope: Envelope<T>): string {
  return JSON.stringify(envelope);
}

function isExpired<T>(entry: StoredEntry<T>, now: number): boolean {
  return entry.expiresAt != null && now >= entry.expiresAt;
}

function pruneExpiredEntries<T>(envelope: Envelope<T>, now: number): boolean {
  let changed = false;
  for (const [id, entry] of Object.entries(envelope.entries)) {
    if (isExpired(entry, now)) {
      delete envelope.entries[id];
      changed = true;
    }
  }
  return changed;
}

function sortEntries<T>(
  entries: Array<PersistentKeyedStoreEntry<T>>,
): Array<PersistentKeyedStoreEntry<T>> {
  return entries.toSorted(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

function toPublicEntry<T>(id: string, entry: StoredEntry<T>): PersistentKeyedStoreEntry<T> {
  const publicEntry: PersistentKeyedStoreEntry<T> = {
    id,
    record: entry.record,
    createdAt: entry.createdAt,
  };
  if (entry.expiresAt != null) {
    publicEntry.expiresAt = entry.expiresAt;
  }
  return publicEntry;
}

function enforceMaxEntries<T>(envelope: Envelope<T>, maxEntries: number): boolean {
  const liveEntries = sortEntries(
    Object.entries(envelope.entries).map(([id, entry]) => toPublicEntry(id, entry)),
  );
  const overflow = liveEntries.length - maxEntries;
  if (overflow <= 0) {
    return false;
  }
  for (const entry of liveEntries.slice(0, overflow)) {
    delete envelope.entries[entry.id];
  }
  return true;
}

async function readEnvelopeDetailed<T>(filePath: string): Promise<ReadEnvelopeResult<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: "quarantine",
      versionLabel: "vunknown",
      reason: "corrupt",
    };
  }

  if (!isRecord(parsed)) {
    return {
      kind: "quarantine",
      versionLabel: "vunknown",
      reason: "corrupt",
    };
  }

  const rawVersion = parsed.version;
  const rawEntries = parsed.entries;
  if (!Number.isInteger(rawVersion)) {
    return {
      kind: "quarantine",
      versionLabel: "vunknown",
      reason: "corrupt",
    };
  }
  const version = rawVersion as number;
  if (version > STORE_VERSION) {
    return {
      kind: "quarantine",
      versionLabel: `v${version}`,
      reason: "version-mismatch",
      version,
    };
  }
  if (version !== STORE_VERSION || !isRecord(rawEntries)) {
    return {
      kind: "quarantine",
      versionLabel: `v${version}`,
      reason: "corrupt",
      version,
    };
  }

  const entries = rawEntries;
  const sanitizedEntries: Record<string, StoredEntry<T>> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (!id || id.trim() !== id || !isRecord(entry) || !isFiniteNumber(entry.createdAt)) {
      return {
        kind: "quarantine",
        versionLabel: `v${version}`,
        reason: "corrupt",
        version,
      };
    }

    const expiresAt = entry.expiresAt;
    if (expiresAt != null && !isFiniteNumber(expiresAt)) {
      return {
        kind: "quarantine",
        versionLabel: `v${version}`,
        reason: "corrupt",
        version,
      };
    }

    sanitizedEntries[id] = {
      record: (entry as { record: T }).record,
      createdAt: entry.createdAt,
      ...(expiresAt != null ? { expiresAt } : {}),
    };
  }

  return {
    kind: "ok",
    envelope: {
      version: STORE_VERSION,
      entries: sanitizedEntries,
    },
  };
}

async function quarantineStoreFile(
  filePath: string,
  params: {
    versionLabel: string;
    reason: "corrupt" | "version-mismatch";
    version?: number;
    logger: PersistentKeyedStoreLogger;
  },
): Promise<void> {
  const extension = path.extname(filePath) || ".json";
  const baseName = path.basename(filePath, extension);
  const quarantinePath = path.join(
    path.dirname(filePath),
    `${baseName}.${params.versionLabel}.corrupt-${Date.now()}${extension}`,
  );

  try {
    await fs.rename(filePath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  params.logger.warn("persistent-keyed-store quarantined store file and started empty", {
    filePath,
    quarantinePath,
    reason: params.reason,
    ...(params.version != null ? { version: params.version } : {}),
  });
}

function runSerializedStoreAccess<R>(filePath: string, fn: () => Promise<R>): Promise<R> {
  const previous = ACCESS_QUEUES.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  ACCESS_QUEUES.set(filePath, next);
  next
    .finally(() => {
      if (ACCESS_QUEUES.get(filePath) === next) {
        ACCESS_QUEUES.delete(filePath);
      }
    })
    .catch(() => {});
  return next;
}

async function loadEnvelopeOrEmpty<T>(
  filePath: string,
  logger: PersistentKeyedStoreLogger,
): Promise<Envelope<T>> {
  const result = await readEnvelopeDetailed<T>(filePath);
  if (result.kind === "missing") {
    return createEmptyEnvelope();
  }
  if (result.kind === "ok") {
    return result.envelope;
  }
  await quarantineStoreFile(filePath, {
    versionLabel: result.versionLabel,
    reason: result.reason,
    version: result.version,
    logger,
  });
  return createEmptyEnvelope();
}

function buildEntriesList<T>(envelope: Envelope<T>): Array<PersistentKeyedStoreEntry<T>> {
  return sortEntries(
    Object.entries(envelope.entries).map(([id, entry]) => toPublicEntry(id, entry)),
  );
}

export function createPersistentKeyedStore<T>(
  options: PersistentKeyedStoreOptions,
): PersistentKeyedStore<T> {
  const namespace = validateNamespace(options.namespace);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs, "defaultTtlMs");
  const maxEntries = validateMaxEntries(options.maxEntries);
  const lockOptions = mergeLockOptions(options.lockOptions);
  const logger: PersistentKeyedStoreLogger = {
    warn: options.logger?.warn ?? console.warn.bind(console),
  };
  const filePath = resolveStoreFilePath(namespace, options.stateDir);

  async function accessStore<R>(fn: (envelope: Envelope<T>) => Promise<R>): Promise<R> {
    return runSerializedStoreAccess(filePath, () =>
      withFileLock(filePath, lockOptions, async () => {
        const envelope = await loadEnvelopeOrEmpty<T>(filePath, logger);
        return fn(envelope);
      }),
    );
  }

  async function register(
    id: string,
    record: T,
    registerOptions?: { ttlMs?: number },
  ): Promise<void> {
    const normalizedId = validateId(id);
    const ttlMs = validateOptionalTtlMs(registerOptions?.ttlMs, "ttlMs") ?? defaultTtlMs;
    const now = Date.now();
    await accessStore(async (envelope) => {
      const original = serializeEnvelope(envelope);
      pruneExpiredEntries(envelope, now);
      envelope.entries[normalizedId] = {
        record,
        createdAt: now,
        ...(ttlMs != null ? { expiresAt: now + ttlMs } : {}),
      };
      pruneExpiredEntries(envelope, now);
      enforceMaxEntries(envelope, maxEntries);
      if (serializeEnvelope(envelope) === original) {
        return;
      }
      await writeJsonFileAtomically(filePath, envelope);
    });
  }

  async function lookup(id: string): Promise<T | undefined> {
    const normalizedId = validateId(id);
    return accessStore(async (envelope) => {
      const original = serializeEnvelope(envelope);
      const now = Date.now();
      pruneExpiredEntries(envelope, now);
      if (serializeEnvelope(envelope) !== original) {
        await writeJsonFileAtomically(filePath, envelope);
      }
      return envelope.entries[normalizedId]?.record;
    });
  }

  async function consume(id: string): Promise<T | undefined> {
    const normalizedId = validateId(id);
    return accessStore(async (envelope) => {
      const now = Date.now();
      const original = serializeEnvelope(envelope);
      pruneExpiredEntries(envelope, now);
      const entry = envelope.entries[normalizedId];
      if (!entry) {
        if (serializeEnvelope(envelope) !== original) {
          await writeJsonFileAtomically(filePath, envelope);
        }
        return undefined;
      }
      delete envelope.entries[normalizedId];
      await writeJsonFileAtomically(filePath, envelope);
      return entry.record;
    });
  }

  async function entries(): Promise<PersistentKeyedStoreEntry<T>[]> {
    return accessStore(async (envelope) => {
      const original = serializeEnvelope(envelope);
      pruneExpiredEntries(envelope, Date.now());
      if (serializeEnvelope(envelope) !== original) {
        await writeJsonFileAtomically(filePath, envelope);
      }
      return buildEntriesList(envelope);
    });
  }

  async function clear(): Promise<void> {
    await runSerializedStoreAccess(filePath, () =>
      withFileLock(filePath, lockOptions, () =>
        writeJsonFileAtomically(filePath, createEmptyEnvelope()),
      ),
    );
  }

  return {
    register,
    lookup,
    consume,
    entries,
    clear,
  };
}
