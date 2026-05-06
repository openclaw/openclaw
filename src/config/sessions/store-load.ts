import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import {
  cloneSessionStoreRecord,
  isSessionStoreCacheEnabled,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import {
  isSessionStoreRecord,
  isValidSessionEntry,
} from "./store-validation.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  runMaintenance?: boolean;
  clone?: boolean;
};

const log = createSubsystemLogger("sessions/store");

// --- Recovery logic for OOM/crash-corrupted session stores ---

const SESSION_STORE_RECOVERY_STALE_MS = 5000;
const SESSION_STORE_MAX_RECOVERY_CANDIDATES = 50;

interface RecoveryCandidate {
  path: string;
  mtimeMs: number;
  source: "bak" | "tmp";
  sourceRank: number;
  store?: Record<string, SessionEntry>;
  validEntryCount?: number;
}

function collectSessionStoreRecoveryCandidates(storePath: string): {
  candidates: RecoveryCandidate[];
  totalCandidateCount: number;
  freshTmpCount: number;
} {
  const storeDir = path.dirname(storePath);
  const storeBase = path.basename(storePath);
  const now = Date.now();
  const candidates: RecoveryCandidate[] = [];
  let freshTmpCount = 0;

  // Always check .bak first, not subject to tmp count limit
  const bakPath = `${storePath}.bak`;
  try {
    const stat = fs.statSync(bakPath);
    if (stat.size > 0) {
      candidates.push({
        path: bakPath,
        mtimeMs: stat.mtimeMs,
        source: "bak",
        sourceRank: 3,
      });
    }
  } catch {
    // No .bak file — that's fine
  }

  // Collect all tmp candidates before capping
  const rawTmpCandidates: RecoveryCandidate[] = [];
  try {
    const entries = fs.readdirSync(storeDir);
    for (const entry of entries) {
      const isSessionTmp = entry.startsWith(`${storeBase}.`) && entry.endsWith(".tmp");
      const isFsSafeReplaceTmp = entry.startsWith(".fs-safe-replace.") && entry.endsWith(".tmp");
      if (!isSessionTmp && !isFsSafeReplaceTmp) continue;
      const tmpPath = path.join(storeDir, entry);
      try {
        const stat = fs.statSync(tmpPath);
        if (stat.size <= 0) continue;
        const ageMs = now - stat.mtimeMs;
        const isFresh = ageMs < SESSION_STORE_RECOVERY_STALE_MS;
        if (isFresh) {
          freshTmpCount++;
        }
        rawTmpCandidates.push({
          path: tmpPath,
          mtimeMs: stat.mtimeMs,
          source: "tmp",
          sourceRank: isFresh ? 1 : 2,
        });
      } catch {
        // stat failed — skip
      }
    }
  } catch {
    // readdir failed — skip
  }

  // Sort stale tmp by mtime desc, then apply cap
  rawTmpCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cappedTmp = rawTmpCandidates.slice(0, SESSION_STORE_MAX_RECOVERY_CANDIDATES);

  // .bak always included (prepended); then capped stale tmp
  const allCandidates = candidates.concat(cappedTmp);

  return {
    candidates: allCandidates,
    totalCandidateCount: allCandidates.length,
    freshTmpCount,
  };
}

function evaluateRecoveryCandidate(
  candidate: RecoveryCandidate,
): RecoveryCandidate | null {
  try {
    const raw = fs.readFileSync(candidate.path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isSessionStoreRecord(parsed)) {
      return null;
    }
    let validEntryCount = 0;
    for (const key of Object.keys(parsed)) {
      if (isValidSessionEntry(parsed[key])) {
        validEntryCount++;
      }
    }
    if (validEntryCount <= 0) {
      return null;
    }
    return { ...candidate, store: parsed, validEntryCount };
  } catch {
    return null;
  }
}

function tryRecoverSessionStore(
  storePath: string,
): RecoveryCandidate | null {
  const { candidates, totalCandidateCount, freshTmpCount } =
    collectSessionStoreRecoveryCandidates(storePath);
  if (candidates.length === 0) {
    return null;
  }

  let invalidCount = 0;
  const invalidReasons: string[] = [];

  for (const candidate of candidates) {
    const evaluated = evaluateRecoveryCandidate(candidate);
    if (evaluated) {
      return evaluated;
    }
    invalidCount++;
    if (invalidReasons.length < 3) {
      invalidReasons.push(`${candidate.source}:${candidate.path}`);
    }
  }

  if (totalCandidateCount > 0) {
    log.debug("no valid recovery candidate found", {
      storePath,
      totalCandidateCount,
      invalidCandidateCount: invalidCount,
      freshTmpCount,
      sampleInvalidReasons: invalidReasons,
    });
  }

  return null;
}

function selfHealWriteback(
  storePath: string,
  store: Record<string, SessionEntry>,
  recoveryPath: string,
  recoverySource: string,
  entryCount: number | undefined,
): void {
  const tmpPath = `${storePath}.${crypto.randomUUID()}.tmp`;
  try {
    const json = JSON.stringify(store, null, 2);
    const fd = fs.openSync(tmpPath, "w", 0o600);
    try {
      fs.writeFileSync(fd, json, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, storePath);
    try {
      fs.chmodSync(storePath, 0o600);
    } catch {
      // chmod best-effort
    }
    try {
      const dirFd = fs.openSync(path.dirname(storePath), "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // dir fsync best-effort
    }
    log.info("self-healed session store from backup/tmp", {
      storePath,
      recoverySource,
      recoveryPath,
      entryCount,
    });
  } catch (writeError: unknown) {
    log.warn("failed to self-heal session store after recovery", {
      storePath,
      recoverySource,
      recoveryPath,
      entryCount,
      error:
        writeError instanceof Error
          ? writeError.message
          : String(writeError),
    });
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // cleanup best-effort
    }
  }
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId:
      entry.lastThreadId ??
      entry.deliveryContext?.threadId ??
      entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) ===
      nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

// resolvedSkills carries the full parsed Skill[] (including each SKILL.md body)
// and is only used as an in-turn cache by the runtime — see
// src/agents/pi-embedded-runner/skills-runtime.ts. Persisting it bloats
// sessions.json by orders of magnitude when many sessions are active. Strip
// it from every entry that flows through normalize, so neither the in-memory
// store reloaded from disk nor the JSON serialized back to disk carries it.
function stripPersistedSkillsCache(entry: SessionEntry): SessionEntry {
  const snapshot = entry.skillsSnapshot;
  if (!snapshot || snapshot.resolvedSkills === undefined) {
    return entry;
  }
  const { resolvedSkills: _drop, ...rest } = snapshot;
  return { ...entry, skillsSnapshot: rest };
}

export function normalizeSessionStore(
  store: Record<string, SessionEntry>,
): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = stripPersistedSkillsCache(
      normalizeSessionEntryDelivery(
        normalizeSessionRuntimeModelFields(entry),
      ),
    );
    if (normalized !== entry) {
      store[key] = normalized;
      changed = true;
    }
  }
  return changed;
}

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = readSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
      clone: opts.clone,
    });
    if (cached) {
      return cached;
    }
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  let fileStat = getFileStatSnapshot(storePath);
  let mtimeMs = fileStat?.mtimeMs;
  let serializedFromDisk: string | undefined;
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf =
    maxReadAttempts > 1
      ? new Int32Array(new SharedArrayBuffer(4))
      : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed = JSON.parse(raw);
      if (isSessionStoreRecord(parsed)) {
        store = parsed;
        serializedFromDisk = raw;
      }
      fileStat = getFileStatSnapshot(storePath) ?? fileStat;
      mtimeMs = fileStat?.mtimeMs;
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  // Recovery: if main file exists but is corrupted/empty/non-object, try .bak/.tmp
  const mainFileExists = (() => {
    try {
      fs.accessSync(storePath);
      return true;
    } catch {
      return false;
    }
  })();
  const mainFileCorruptedOrEmpty =
    mainFileExists &&
    serializedFromDisk === undefined &&
    Object.keys(store).length === 0;
  if (mainFileCorruptedOrEmpty) {
    const recovered = tryRecoverSessionStore(storePath);
    if (recovered?.store) {
      store = recovered.store;
      serializedFromDisk = undefined; // cache miss → subsequent save proceeds

      // Self-heal: atomically write recovered store back to main file
      selfHealWriteback(
        storePath,
        store,
        recovered.path,
        recovered.source,
        recovered.validEntryCount,
      );
    }
  }

  const migrated = applySessionStoreMigrations(store);
  const normalized = normalizeSessionStore(store);
  if (migrated || normalized) {
    serializedFromDisk = undefined;
  }
  if (opts.runMaintenance) {
    const maintenance = opts.maintenanceConfig ?? resolveMaintenanceConfig();
    const beforeCount = Object.keys(store).length;
    if (maintenance.mode === "enforce" && beforeCount > maintenance.maxEntries) {
      const pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
        log: false,
      });
      const countAfterPrune = Object.keys(store).length;
      const capped = shouldRunSessionEntryMaintenance({
        entryCount: countAfterPrune,
        maxEntries: maintenance.maxEntries,
      })
        ? capEntryCount(store, maintenance.maxEntries, { log: false })
        : 0;
      const afterCount = Object.keys(store).length;
      if (pruned > 0 || capped > 0) {
        serializedFromDisk = undefined;
        log.info("applied load-time maintenance to oversized session store", {
          storePath,
          before: beforeCount,
          after: afterCount,
          pruned,
          capped,
          maxEntries: maintenance.maxEntries,
        });
      }
    }
  }

  setSerializedSessionStore(storePath, serializedFromDisk);

  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs,
      sizeBytes: fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  }

  return opts.clone === false
    ? store
    : cloneSessionStoreRecord(store, serializedFromDisk);
}
