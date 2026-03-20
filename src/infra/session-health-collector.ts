/**
 * Session Health — Snapshot Collector
 *
 * Collects a raw `SessionHealthRawSnapshot` by scanning session stores and
 * disk artifacts across all configured agents. Designed to run periodically
 * on a timer, producing cached snapshots for the health RPC to serve.
 *
 * Performance considerations:
 * - Uses `loadSessionStore({ skipCache: true })` to get a fresh read.
 * - Reads the sessions directory once per agent (same cost as existing
 *   `enforceSessionDiskBudget`).
 * - Writes snapshots atomically to avoid partial reads.
 * - Prunes history older than 7 days to keep disk usage bounded.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { STATE_DIR } from "../config/paths.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { resolveMaintenanceConfig } from "../config/sessions/store-maintenance.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";
import { classifyDiskArtifact, classifySessionKeyForHealth } from "./session-health-classify.js";
import type {
  DiskStateCounts,
  SessionHealthAgentBreakdown,
  SessionHealthClass,
  SessionHealthClassCounts,
  SessionHealthDrift,
  SessionHealthGrowth,
  SessionHealthRawSnapshot,
  SessionHealthStorageBreakdown,
  SessionHealthSurface,
} from "./session-health-types.js";
import { DEFAULT_CLASS_RETENTION_MS } from "./session-health-types.js";

const log = createSubsystemLogger("session-health");

// ---------------------------------------------------------------------------
// Cache paths
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(STATE_DIR, "cache", "session-health");
const SNAPSHOT_PATH = path.join(CACHE_DIR, "snapshot.json");
const DERIVED_PATH = path.join(CACHE_DIR, "derived.json");
const HISTORY_DIR = path.join(CACHE_DIR, "history");
const HISTORY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Agent resolution (mirrors health.ts resolveAgentOrder locally)
// ---------------------------------------------------------------------------

function resolveAgentOrder(cfg: OpenClawConfig): {
  defaultAgentId: string;
  ordered: Array<{ id: string; name?: string }>;
} {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const seen = new Set<string>();
  const ordered: Array<{ id: string; name?: string }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (typeof (entry as Record<string, unknown>).id !== "string") {
      continue;
    }
    const id = normalizeAgentId((entry as Record<string, unknown>).id as string);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push({
      id,
      name:
        typeof (entry as Record<string, unknown>).name === "string"
          ? ((entry as Record<string, unknown>).name as string)
          : undefined,
    });
  }

  if (!seen.has(defaultAgentId)) {
    ordered.unshift({ id: defaultAgentId });
  }
  if (ordered.length === 0) {
    ordered.push({ id: defaultAgentId });
  }

  return { defaultAgentId, ordered };
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

type DirFileStat = {
  name: string;
  size: number;
  mtimeMs: number;
};

async function readSessionsDirFiles(sessionsDir: string): Promise<DirFileStat[]> {
  let dirEntries: import("node:fs").Dirent[];
  try {
    dirEntries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: DirFileStat[] = [];
  for (const dirent of dirEntries) {
    if (!dirent.isFile()) {
      continue;
    }
    try {
      const stat = await fs.stat(path.join(sessionsDir, dirent.name));
      if (stat.isFile()) {
        files.push({ name: String(dirent.name), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Skip files we can't stat (e.g., race condition deletion).
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function emptyClassCounts(): SessionHealthClassCounts {
  return {
    main: 0,
    channel: 0,
    direct: 0,
    "cron-definition": 0,
    "cron-run": 0,
    subagent: 0,
    acp: 0,
    heartbeat: 0,
    thread: 0,
    unknown: 0,
  };
}

function emptyDiskStateCounts(): DiskStateCounts {
  return { active: 0, deleted: 0, reset: 0, orphanedTemp: 0 };
}

// ---------------------------------------------------------------------------
// Per-agent collection
// ---------------------------------------------------------------------------

type AgentCollectionResult = {
  breakdown: SessionHealthAgentBreakdown;
  byDiskState: DiskStateCounts;
  storage: SessionHealthStorageBreakdown;
  drift: SessionHealthDrift;
  staleByClass: Partial<SessionHealthClassCounts>;
  parseTimeMs: number | null;
};

async function collectForAgent(params: {
  agentId: string;
  storePath: string;
}): Promise<AgentCollectionResult> {
  const { agentId, storePath } = params;
  const sessionsDir = path.dirname(storePath);

  // 1. Load session store with timing
  let store: Record<string, unknown> = {};
  let parseTimeMs: number | null = null;
  try {
    const t0 = performance.now();
    store = loadSessionStore(storePath, { skipCache: true });
    parseTimeMs = Math.round((performance.now() - t0) * 100) / 100;
  } catch (err) {
    log.warn("failed to load session store for agent", { agentId, error: String(err) });
  }

  // 2. Classify session keys and compute stale-per-class counts
  const byClass = emptyClassCounts();
  const staleByClass: Partial<SessionHealthClassCounts> = {};
  const storeKeys = Object.keys(store);
  const now = Date.now();
  for (const key of storeKeys) {
    const cls = classifySessionKeyForHealth(key);
    byClass[cls]++;

    // Compute stale count for prunable classes
    const retentionMs = DEFAULT_CLASS_RETENTION_MS[cls];
    if (retentionMs != null) {
      const entry = store[key] as Record<string, unknown> | undefined;
      const updatedAt = typeof entry?.updatedAt === "number" ? entry.updatedAt : 0;
      if (updatedAt > 0 && now - updatedAt > retentionMs) {
        staleByClass[cls] = (staleByClass[cls] ?? 0) + 1;
      }
    }
  }

  // 3. Read directory files
  const files = await readSessionsDirFiles(sessionsDir);

  // 4. Classify disk artifacts and compute storage
  const byDiskState = emptyDiskStateCounts();
  const storage: SessionHealthStorageBreakdown = {
    totalManagedBytes: 0,
    sessionsJsonBytes: 0,
    activeTranscriptBytes: 0,
    deletedTranscriptBytes: 0,
    resetTranscriptBytes: 0,
    orphanedTempBytes: 0,
  };

  // Build a set of active .jsonl files referenced by index keys
  // We'll use this for drift detection below.
  const diskFileBaseNames = new Set<string>();

  for (const file of files) {
    const state = classifyDiskArtifact(file.name);
    storage.totalManagedBytes += file.size;

    switch (state) {
      case "index":
        storage.sessionsJsonBytes += file.size;
        break;
      case "backup":
        // backups counted in total but not in breakdown categories
        break;
      case "active":
        byDiskState.active++;
        storage.activeTranscriptBytes += file.size;
        // Track for drift detection: strip .jsonl to get session ID
        if (file.name.endsWith(".jsonl")) {
          diskFileBaseNames.add(file.name);
        }
        break;
      case "deleted":
        byDiskState.deleted++;
        storage.deletedTranscriptBytes += file.size;
        break;
      case "reset":
        byDiskState.reset++;
        storage.resetTranscriptBytes += file.size;
        break;
      case "orphanedTemp":
        byDiskState.orphanedTemp++;
        storage.orphanedTempBytes += file.size;
        break;
    }
  }

  // 5. Drift detection
  // Compare index keys against active disk files.
  // Note: session entries store a sessionId that maps to a .jsonl file.
  // We do a simplified check: for each store key, see if any active .jsonl exists.
  // Precise sessionId → filename mapping varies, so we count mismatches loosely.
  let indexedWithoutDiskFile = 0;
  const indexedSessionIds = new Set<string>();

  for (const key of storeKeys) {
    const entry = store[key] as Record<string, unknown> | undefined;
    const sessionId = (entry?.sessionId as string) ?? "";
    if (sessionId) {
      indexedSessionIds.add(sessionId);
      const expectedFile = `${sessionId}.jsonl`;
      if (!diskFileBaseNames.has(expectedFile)) {
        indexedWithoutDiskFile++;
      }
    }
  }

  // Disk files without index: active .jsonl files whose sessionId is not in the store
  let diskFilesWithoutIndex = 0;
  for (const fileName of diskFileBaseNames) {
    const sessionId = fileName.replace(/\.jsonl$/, "");
    if (!indexedSessionIds.has(sessionId)) {
      diskFilesWithoutIndex++;
    }
  }

  // Orphaned temp stats
  const orphanedTempFiles = files.filter((f) => classifyDiskArtifact(f.name) === "orphanedTemp");
  const oldestOrphanedTemp =
    orphanedTempFiles.length > 0
      ? orphanedTempFiles.reduce(
          (oldest, f) => (f.mtimeMs < oldest.mtimeMs ? f : oldest),
          orphanedTempFiles[0],
        )
      : null;

  const drift: SessionHealthDrift = {
    indexedWithoutDiskFile,
    diskFilesWithoutIndex,
    orphanedTempCount: byDiskState.orphanedTemp,
    oldestOrphanedTempAt: oldestOrphanedTemp
      ? new Date(oldestOrphanedTemp.mtimeMs).toISOString()
      : null,
    reconciliationRecommended:
      indexedWithoutDiskFile > 5 || diskFilesWithoutIndex > 5 || byDiskState.orphanedTemp > 0,
  };

  return {
    breakdown: {
      agentId,
      storePath,
      indexedCount: storeKeys.length,
      byClass,
      totalManagedBytes: storage.totalManagedBytes,
      resetTranscriptBytes: storage.resetTranscriptBytes,
    },
    byDiskState,
    storage,
    drift,
    staleByClass,
    parseTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collectSessionHealth(
  cfg?: OpenClawConfig,
): Promise<SessionHealthRawSnapshot> {
  const t0 = performance.now();
  const resolvedCfg = cfg ?? loadConfig();
  const { ordered } = resolveAgentOrder(resolvedCfg);
  const maintenance = resolveMaintenanceConfig();

  // Collect per-agent data
  const agentResults: AgentCollectionResult[] = [];
  for (const agent of ordered) {
    const storePath = resolveStorePath(resolvedCfg.session?.store, { agentId: agent.id });
    try {
      const result = await collectForAgent({ agentId: agent.id, storePath });
      agentResults.push(result);
    } catch (err) {
      log.warn("session health collection failed for agent", {
        agentId: agent.id,
        error: String(err),
      });
    }
  }

  // Merge across agents
  const mergedClass = emptyClassCounts();
  const mergedDiskState = emptyDiskStateCounts();
  const mergedStorage: SessionHealthStorageBreakdown = {
    totalManagedBytes: 0,
    sessionsJsonBytes: 0,
    activeTranscriptBytes: 0,
    deletedTranscriptBytes: 0,
    resetTranscriptBytes: 0,
    orphanedTempBytes: 0,
  };
  const mergedDrift: SessionHealthDrift = {
    indexedWithoutDiskFile: 0,
    diskFilesWithoutIndex: 0,
    orphanedTempCount: 0,
    oldestOrphanedTempAt: null,
    reconciliationRecommended: false,
  };
  const mergedStaleByClass: Partial<SessionHealthClassCounts> = {};
  let totalIndexed = 0;
  let totalSessionsJsonBytes = 0;
  let bestParseTimeMs: number | null = null;

  for (const result of agentResults) {
    const { breakdown, byDiskState, storage, drift, staleByClass, parseTimeMs } = result;
    totalIndexed += breakdown.indexedCount;
    totalSessionsJsonBytes += storage.sessionsJsonBytes;

    // Merge class counts
    for (const [cls, count] of Object.entries(breakdown.byClass)) {
      mergedClass[cls as keyof SessionHealthClassCounts] += count;
    }

    // Merge stale-per-class counts
    for (const [cls, count] of Object.entries(staleByClass)) {
      if (count != null && count > 0) {
        mergedStaleByClass[cls as SessionHealthClass] =
          (mergedStaleByClass[cls as SessionHealthClass] ?? 0) + count;
      }
    }

    // Merge disk state counts
    for (const [state, count] of Object.entries(byDiskState)) {
      mergedDiskState[state as keyof DiskStateCounts] += count;
    }

    // Merge storage
    for (const key of Object.keys(mergedStorage) as (keyof SessionHealthStorageBreakdown)[]) {
      mergedStorage[key] += storage[key];
    }

    // Merge drift
    mergedDrift.indexedWithoutDiskFile += drift.indexedWithoutDiskFile;
    mergedDrift.diskFilesWithoutIndex += drift.diskFilesWithoutIndex;
    mergedDrift.orphanedTempCount += drift.orphanedTempCount;
    if (drift.reconciliationRecommended) {
      mergedDrift.reconciliationRecommended = true;
    }
    if (drift.oldestOrphanedTempAt) {
      if (
        !mergedDrift.oldestOrphanedTempAt ||
        drift.oldestOrphanedTempAt < mergedDrift.oldestOrphanedTempAt
      ) {
        mergedDrift.oldestOrphanedTempAt = drift.oldestOrphanedTempAt;
      }
    }

    // Track parse time (use the primary/longest)
    if (parseTimeMs != null) {
      if (bestParseTimeMs == null || parseTimeMs > bestParseTimeMs) {
        bestParseTimeMs = parseTimeMs;
      }
    }
  }

  // Compute usage percentages
  const usageEntries =
    maintenance.maxEntries > 0
      ? Math.round((totalIndexed / maintenance.maxEntries) * 10000) / 100
      : 0;
  const usageDiskBytes =
    maintenance.maxDiskBytes != null && maintenance.maxDiskBytes > 0
      ? Math.round((mergedStorage.totalManagedBytes / maintenance.maxDiskBytes) * 10000) / 100
      : null;

  // Growth deltas from previous snapshot
  const growth = await computeGrowthDeltas({
    currentIndexedCount: totalIndexed,
    currentTotalBytes: mergedStorage.totalManagedBytes,
  });

  const collectorDurationMs = Math.round((performance.now() - t0) * 100) / 100;
  const capturedAt = new Date().toISOString();

  const snapshot: SessionHealthRawSnapshot = {
    capturedAt,
    collectorDurationMs,
    sessions: {
      indexedCount: totalIndexed,
      sessionsJsonBytes: totalSessionsJsonBytes,
      sessionsJsonParseTimeMs: bestParseTimeMs,
      byClass: mergedClass,
      staleByClass: Object.keys(mergedStaleByClass).length > 0 ? mergedStaleByClass : undefined,
      byDiskState: mergedDiskState,
    },
    storage: mergedStorage,
    drift: mergedDrift,
    maintenance: {
      mode: maintenance.mode,
      maxEntries: maintenance.maxEntries,
      pruneAfterMs: maintenance.pruneAfterMs,
      maxDiskBytes: maintenance.maxDiskBytes,
      usagePercent: {
        entries: usageEntries,
        diskBytes: usageDiskBytes,
      },
    },
    growth,
    agents: agentResults.map((r) => r.breakdown),
  };

  return snapshot;
}

// ---------------------------------------------------------------------------
// Growth delta computation
// ---------------------------------------------------------------------------

async function computeGrowthDeltas(params: {
  currentIndexedCount: number;
  currentTotalBytes: number;
}): Promise<SessionHealthGrowth> {
  const growth: SessionHealthGrowth = {
    sessionsBytes24h: null,
    sessionsBytes7d: null,
    indexedCount24h: null,
    indexedCount7d: null,
  };

  try {
    const historyFiles = await listHistoryFiles();
    if (historyFiles.length === 0) {
      return growth;
    }

    const now = Date.now();
    const h24 = now - 24 * 60 * 60 * 1000;
    const d7 = now - 7 * 24 * 60 * 60 * 1000;

    // Find the closest snapshot to 24h ago and 7d ago
    const closest24h = findClosestSnapshot(historyFiles, h24);
    const closest7d = findClosestSnapshot(historyFiles, d7);

    if (closest24h) {
      const prev = await readJsonFile<SessionHealthRawSnapshot>(closest24h.path);
      if (prev) {
        growth.sessionsBytes24h = params.currentTotalBytes - prev.storage.totalManagedBytes;
        growth.indexedCount24h = params.currentIndexedCount - prev.sessions.indexedCount;
      }
    }

    if (closest7d) {
      const prev = await readJsonFile<SessionHealthRawSnapshot>(closest7d.path);
      if (prev) {
        growth.sessionsBytes7d = params.currentTotalBytes - prev.storage.totalManagedBytes;
        growth.indexedCount7d = params.currentIndexedCount - prev.sessions.indexedCount;
      }
    }
  } catch {
    // Growth deltas are best-effort; don't fail the collection.
  }

  return growth;
}

type HistoryFile = { path: string; timestamp: number };

async function listHistoryFiles(): Promise<HistoryFile[]> {
  try {
    const entries = await fs.readdir(HISTORY_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => {
        const ts = parseHistoryTimestamp(e.name);
        return ts ? { path: path.join(HISTORY_DIR, e.name), timestamp: ts } : null;
      })
      .filter((e): e is HistoryFile => e != null)
      .toSorted((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

function parseHistoryTimestamp(filename: string): number | null {
  // Format: YYYY-MM-DDTHH-MM.json
  const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})\.json$/);
  if (!match) {
    return null;
  }
  const isoLike = match[1].replace(/T(\d{2})-(\d{2})$/, "T$1:$2:00Z");
  const ts = Date.parse(isoLike);
  return Number.isNaN(ts) ? null : ts;
}

function findClosestSnapshot(files: HistoryFile[], targetMs: number): HistoryFile | null {
  if (files.length === 0) {
    return null;
  }

  let closest: HistoryFile | null = null;
  let closestDiff = Number.POSITIVE_INFINITY;

  for (const file of files) {
    // Only consider files that are older than or at the target time
    if (file.timestamp > targetMs + 10 * 60 * 1000) {
      continue;
    } // Allow 10 min tolerance
    const diff = Math.abs(file.timestamp - targetMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = file;
    }
  }

  return closest;
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

export async function writeCachedSnapshot(snapshot: SessionHealthRawSnapshot): Promise<void> {
  try {
    await writeJsonAtomic(SNAPSHOT_PATH, snapshot);
  } catch (err) {
    log.warn("failed to write session health snapshot", { error: String(err) });
  }
}

export async function readCachedSnapshot(): Promise<SessionHealthRawSnapshot | null> {
  return readJsonFile<SessionHealthRawSnapshot>(SNAPSHOT_PATH);
}

export async function writeHistorySnapshot(snapshot: SessionHealthRawSnapshot): Promise<void> {
  try {
    const d = new Date(snapshot.capturedAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const filename = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}.json`;
    await writeJsonAtomic(path.join(HISTORY_DIR, filename), snapshot);
  } catch (err) {
    log.warn("failed to write session health history", { error: String(err) });
  }
}

export async function pruneOldHistory(): Promise<number> {
  try {
    const files = await listHistoryFiles();
    const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
    let pruned = 0;
    for (const file of files) {
      if (file.timestamp < cutoff) {
        await fs.rm(file.path, { force: true }).catch(() => undefined);
        pruned++;
      }
    }
    return pruned;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Derived surface persistence (Layer B)
// ---------------------------------------------------------------------------

export async function writeCachedDerivedSurface(surface: SessionHealthSurface): Promise<void> {
  try {
    await writeJsonAtomic(DERIVED_PATH, surface);
  } catch (err) {
    log.warn("failed to write session health derived surface", { error: String(err) });
  }
}

export async function readCachedDerivedSurface(): Promise<SessionHealthSurface | null> {
  return readJsonFile<SessionHealthSurface>(DERIVED_PATH);
}

/** Exported cache paths for testing/integration use. */
export const SESSION_HEALTH_CACHE_DIR = CACHE_DIR;
export const SESSION_HEALTH_SNAPSHOT_PATH = SNAPSHOT_PATH;
export const SESSION_HEALTH_DERIVED_PATH = DERIVED_PATH;
