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
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  runMaintenance?: boolean;
  clone?: boolean;
};

const log = createSubsystemLogger("sessions/store");

function isSessionStoreTmpCandidateName(entry: string, storeBase: string): boolean {
  if (!entry.endsWith(".tmp")) {
    return false;
  }

  // Legacy/writeTextAtomic/self-heal temps: sessions.json.<uuid>.tmp
  if (entry.startsWith(`${storeBase}.`)) {
    return true;
  }

  // Pinned fs-safe atomic replace temps: .fs-safe-replace.<pid>.<uuid>.tmp
  if (/^\.fs-safe-replace\.\d+\..+\.tmp$/.test(entry)) {
    return true;
  }

  return false;
}

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
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

export function normalizeSessionStore(store: Record<string, SessionEntry>): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = stripPersistedSkillsCache(
      normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry)),
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
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;

  // P2 #1: Track whether the primary read/parse actually failed
  let primaryReadFailed = false;

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
      // All retries exhausted — primary read failed
      primaryReadFailed = true;
    }
  }

  // P2 #1: Only trigger recovery if primary read/parse ACTUALLY failed
  if (primaryReadFailed || Object.keys(store).length === 0) {
    const storeDir = path.dirname(storePath);

    // 1. Try .bak first
    const bakPath = `${storePath}.bak`;
    try {
      const bakRaw = fs.readFileSync(bakPath, "utf-8");
      const bakParsed = JSON.parse(bakRaw);
      if (isSessionStoreRecord(bakParsed)) {
        store = bakParsed;
        serializedFromDisk = JSON.stringify(store, null, 2);
        log.info("self-healed session store from backup", { storePath, recoverySource: "bak" });
      }
    } catch {
      // no .bak or invalid, continue to tmp
    }

    // 2. Try stale .tmp files if still empty
    if (Object.keys(store).length === 0) {
      try {
        const entries = fs.readdirSync(storeDir);
        const tmpCandidates: { name: string; full: string; mtime: number }[] = [];

        for (const entry of entries) {
          if (!isSessionStoreTmpCandidateName(entry, path.basename(storePath))) {
            continue;
          }

          const fullPath = path.join(storeDir, entry);

          // P2 #3: Use lstatSync and strictly check file integrity
          let stats: fs.Stats;
          try {
            stats = fs.lstatSync(fullPath);
          } catch {
            continue;
          }

          if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
            continue;
          }

          tmpCandidates.push({ name: entry, full: fullPath, mtime: stats.mtimeMs });
        }

        tmpCandidates.sort((a, b) => a.mtime - b.mtime); // oldest first (most stale)

        for (const candidate of tmpCandidates) {
          try {
            const tmpRaw = fs.readFileSync(candidate.full, "utf-8");
            const tmpParsed = JSON.parse(tmpRaw);
            if (isSessionStoreRecord(tmpParsed)) {
              store = tmpParsed;
              serializedFromDisk = JSON.stringify(store, null, 2);
              log.info("self-healed session store from backup/tmp", {
                storePath,
                recoverySource: "tmp",
                recoveryPath: candidate.full,
                entryCount: Object.keys(store).length,
              });
              break;
            }
          } catch {
            // skip invalid tmp
          }
        }
      } catch {
        // readdir failed, skip
      }
    }

    // P2 #4: Self-heal using writeTextAtomic with mode 0o600
    if (Object.keys(store).length > 0 && serializedFromDisk) {
      try {
        // writeTextAtomic is async; use sync fallback for load-time path
        const tmpHeal = `${storePath}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(tmpHeal, serializedFromDisk, { mode: 0o600, encoding: "utf-8" });
        fs.renameSync(tmpHeal, storePath);
        fileStat = getFileStatSnapshot(storePath);
        mtimeMs = fileStat?.mtimeMs;
      } catch {
        // write failed, continue with in-memory store
      }
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
    let pruned = 0;
    let capped = 0;
    if (maintenance.mode === "enforce" && beforeCount > maintenance.maxEntries) {
      pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, { log: false });
      const countAfterPrune = Object.keys(store).length;
      capped = shouldRunSessionEntryMaintenance({
        entryCount: countAfterPrune,
        maxEntries: maintenance.maxEntries,
      })
        ? capEntryCount(store, maintenance.maxEntries, { log: false })
        : 0;
    }
    const afterCount = Object.keys(store).length;
    if (pruned > 0 || capped > 0) {
      serializedFromDisk = undefined;
      log.info("applied load-time maintenance to session store", {
        storePath,
        before: beforeCount,
        after: afterCount,
        pruned,
        capped,
        maxEntries: maintenance.maxEntries,
      });
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

  return opts.clone === false ? store : cloneSessionStoreRecord(store, serializedFromDisk);
}
