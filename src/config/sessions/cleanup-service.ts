import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import { getLogger } from "../../logging/logger.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  isCompactionCheckpointTranscriptFileName,
  parseSessionArchiveTimestamp,
} from "./artifacts.js";
import {
  enforceSessionDiskBudget,
  pruneUnreferencedSessionArtifacts,
  resolveSessionArtifactCanonicalPathsForEntry,
  type SessionUnreferencedArtifactSweepResult,
} from "./disk-budget.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveStorePath,
} from "./paths.js";
import { cloneSessionStoreRecord } from "./store-cache.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
  updateSessionStore,
  type SessionMaintenanceApplyReport,
} from "./store.js";
import {
  resolveSessionStoreTargets,
  type SessionStoreTarget,
  type SessionStoreSelectionOptions,
} from "./targets.js";
import type { SessionEntry } from "./types.js";

export type SessionsCleanupOptions = SessionStoreSelectionOptions & {
  dryRun?: boolean;
  enforce?: boolean;
  activeKey?: string;
  json?: boolean;
  fixMissing?: boolean;
  fixDmScope?: boolean;
};

export type SessionCleanupAction =
  | "keep"
  | "prune-missing"
  | "prune-stale"
  | "cap-overflow"
  | "evict-budget"
  | "retire-dm-scope";

export type ArchivedFilesPlan = {
  scannedDeleted: number;
  scannedReset: number;
  scannedOrphanCheckpoint: number;
  removedDeleted: number;
  removedReset: number;
  removedOrphanCheckpoint: number;
  bytesFreed: number;
  candidatePaths: string[];
};

export type SessionCleanupSummary = {
  agentId: string;
  storePath: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  missing: number;
  dmScopeRetired: number;
  pruned: number;
  capped: number;
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult;
  diskBudget: Awaited<ReturnType<typeof enforceSessionDiskBudget>>;
  archivedFiles: ArchivedFilesPlan;
  wouldMutate: boolean;
  applied?: true;
  appliedCount?: number;
};

export type SessionsCleanupResult =
  | SessionCleanupSummary
  | {
      allAgents: true;
      mode: ResolvedSessionMaintenanceConfig["mode"];
      dryRun: boolean;
      stores: SessionCleanupSummary[];
    };

export type SessionsCleanupRunResult = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  previewResults: Array<{
    summary: SessionCleanupSummary;
    beforeStore: Record<string, SessionEntry>;
    missingKeys: Set<string>;
    staleKeys: Set<string>;
    cappedKeys: Set<string>;
    budgetEvictedKeys: Set<string>;
    dmScopeRetiredKeys: Set<string>;
  }>;
  appliedSummaries: SessionCleanupSummary[];
};

export function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupAction {
  if (params.dmScopeRetiredKeys.has(params.key)) {
    return "retire-dm-scope";
  }
  if (params.missingKeys.has(params.key)) {
    return "prune-missing";
  }
  if (params.staleKeys.has(params.key)) {
    return "prune-stale";
  }
  if (params.cappedKeys.has(params.key)) {
    return "cap-overflow";
  }
  if (params.budgetEvictedKeys.has(params.key)) {
    return "evict-budget";
  }
  return "keep";
}

function isMainScopeStaleDirectSessionKey(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  key: string;
  activeKey?: string;
}): boolean {
  if ((params.cfg.session?.dmScope ?? "main") !== "main") {
    return false;
  }
  if (params.activeKey && params.key === params.activeKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(params.key);
  if (!parsed || normalizeAgentId(parsed.agentId) !== normalizeAgentId(params.targetAgentId)) {
    return false;
  }
  const parts = parsed.rest.split(":").filter(Boolean);
  return (
    (parts.length === 2 && parts[0] === "direct") ||
    (parts.length === 3 && parts[1] === "direct") ||
    (parts.length === 4 && parts[2] === "direct")
  );
}

function rememberRemovedSessionFile(
  removedSessionFiles: Map<string, string | undefined>,
  entry: SessionEntry | undefined,
): void {
  if (entry?.sessionId) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

function retireMainScopeDirectSessionEntries(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  targetAgentId: string;
  activeKey?: string;
  onRetired?: (key: string, entry: SessionEntry) => void;
}): number {
  let retired = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    if (
      isMainScopeStaleDirectSessionKey({
        cfg: params.cfg,
        targetAgentId: params.targetAgentId,
        key,
        activeKey: params.activeKey,
      })
    ) {
      params.onRetired?.(key, entry);
      delete params.store[key];
      retired += 1;
    }
  }
  return retired;
}

export function serializeSessionCleanupResult(params: {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  summaries: SessionCleanupSummary[];
}): SessionsCleanupResult {
  if (params.summaries.length === 1) {
    return params.summaries[0] ?? ({} as SessionCleanupSummary);
  }
  return {
    allAgents: true,
    mode: params.mode,
    dryRun: params.dryRun,
    stores: params.summaries,
  };
}

const CHECKPOINT_TRANSCRIPT_RE =
  /^(.+)\.checkpoint\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i;

export function emptyArchivedFilesPlan(): ArchivedFilesPlan {
  return {
    scannedDeleted: 0,
    scannedReset: 0,
    scannedOrphanCheckpoint: 0,
    removedDeleted: 0,
    removedReset: 0,
    removedOrphanCheckpoint: 0,
    bytesFreed: 0,
    candidatePaths: [],
  };
}

function collectStoreSessionIds(storePath: string): Set<string> {
  const ids = new Set<string>();
  try {
    const store = loadSessionStore(storePath, { skipCache: true });
    for (const entry of Object.values(store)) {
      const id = entry?.sessionId;
      if (typeof id === "string" && id.length > 0) {
        ids.add(id);
      }
    }
  } catch {
    // Best effort; if the store cannot be read here we already surfaced the
    // error elsewhere in the cleanup flow.
  }
  return ids;
}

/**
 * Scan the directory that owns the session store for archived transcripts
 * (`<sessionId>.jsonl.deleted.<ts>` / `.reset.<ts>`) and orphaned compaction
 * checkpoint files (`<sessionId>.checkpoint.<uuid>.jsonl` whose owning session
 * is no longer indexed).
 *
 * Returns a plan describing what would be removed when applied. When `dryRun`
 * is false the plan is also executed and the on-disk files are unlinked.
 *
 * `pruneAfterMs` is the age threshold for `.deleted.*` files; older files are
 * removed and newer ones are kept. `resetArchiveRetentionMs` is the threshold
 * for `.reset.*` files; when null we leave reset files alone (matches the
 * existing runtime behaviour). When `nowMs - timestamp <= olderThanMs`, the
 * file is preserved (matches the existing helper semantics in
 * `cleanupArchivedSessionTranscripts`).
 */
export function planArchivedSessionFileCleanup(params: {
  storePath: string;
  pruneAfterMs: number;
  resetArchiveRetentionMs: number | null;
  dryRun: boolean;
  nowMs?: number;
  /**
   * Optional set of session ids to treat as still referenced. When provided,
   * the planner will skip loading the live session store and use this set
   * directly. This lets dry-run callers pass a simulated post-cleanup id
   * set so orphan-checkpoint detection matches what `--enforce` would do
   * after pruning/capping/evicting entries from the index.
   */
  referencedSessionIds?: ReadonlySet<string>;
}): ArchivedFilesPlan {
  const plan = emptyArchivedFilesPlan();
  const dir = path.dirname(path.resolve(params.storePath));
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return plan;
  }

  const now = params.nowMs ?? Date.now();
  const referencedSessionIds =
    params.referencedSessionIds ?? collectStoreSessionIds(params.storePath);

  type Removal = { fullPath: string; reason: "deleted" | "reset" | "orphan-checkpoint" };
  const removals: Removal[] = [];

  for (const name of entries) {
    const fullPath = path.join(dir, name);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }

    const deletedTs = parseSessionArchiveTimestamp(name, "deleted");
    if (deletedTs != null) {
      plan.scannedDeleted += 1;
      if (now - deletedTs > params.pruneAfterMs) {
        plan.removedDeleted += 1;
        plan.bytesFreed += stat.size;
        plan.candidatePaths.push(fullPath);
        removals.push({ fullPath, reason: "deleted" });
      }
      continue;
    }

    const resetTs = parseSessionArchiveTimestamp(name, "reset");
    if (resetTs != null) {
      plan.scannedReset += 1;
      // Reset retention is optional. When unset (null) we mirror the existing
      // store-runtime behaviour and leave reset files in place — operators
      // can opt in via `sessionMaintenance.resetArchiveRetention`.
      if (params.resetArchiveRetentionMs == null) {
        continue;
      }
      if (now - resetTs > params.resetArchiveRetentionMs) {
        plan.removedReset += 1;
        plan.bytesFreed += stat.size;
        plan.candidatePaths.push(fullPath);
        removals.push({ fullPath, reason: "reset" });
      }
      continue;
    }

    if (isCompactionCheckpointTranscriptFileName(name)) {
      const match = CHECKPOINT_TRANSCRIPT_RE.exec(name);
      const sessionId = match?.[1];
      if (!sessionId) {
        continue;
      }
      plan.scannedOrphanCheckpoint += 1;
      if (referencedSessionIds.has(sessionId)) {
        // Owning session still indexed — leave the checkpoint alone.
        continue;
      }
      plan.removedOrphanCheckpoint += 1;
      plan.bytesFreed += stat.size;
      plan.candidatePaths.push(fullPath);
      removals.push({ fullPath, reason: "orphan-checkpoint" });
    }
  }

  if (!params.dryRun) {
    for (const removal of removals) {
      try {
        fs.rmSync(removal.fullPath, { force: true });
      } catch {
        // Best-effort: a failure to unlink should not abort the run. The
        // plan still reflects what we attempted; a follow-up
        // `cleanup --enforce` will retry.
      }
    }
  }

  return plan;
}

function pruneMissingTranscriptEntries(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  onPruned?: (key: string) => void;
}): number {
  const sessionPathOpts = resolveSessionFilePathOptions({
    storePath: params.storePath,
  });
  let removed = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    if (!entry?.sessionId) {
      continue;
    }
    const transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
    if (!fs.existsSync(transcriptPath)) {
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key);
    }
  }
  return removed;
}

function addEntryArtifactPathsToSet(params: {
  paths: Set<string>;
  store: Record<string, SessionEntry>;
  storePath: string;
  keys: ReadonlySet<string>;
}): void {
  const sessionsDir = path.dirname(params.storePath);
  for (const key of params.keys) {
    const entry = params.store[key];
    if (!entry) {
      continue;
    }
    for (const artifactPath of resolveSessionArtifactCanonicalPathsForEntry({
      sessionsDir,
      entry,
    })) {
      params.paths.add(artifactPath);
    }
  }
}

async function previewStoreCleanup(params: {
  cfg: OpenClawConfig;
  target: SessionStoreTarget;
  maintenance: ResolvedSessionMaintenanceConfig;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  activeKey?: string;
  fixMissing?: boolean;
  fixDmScope?: boolean;
}) {
  const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
  const previewStore = cloneSessionStoreRecord(beforeStore);
  const staleKeys = new Set<string>();
  const cappedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const dmScopeRetiredKeys = new Set<string>();
  const missing =
    params.fixMissing === true
      ? pruneMissingTranscriptEntries({
          store: previewStore,
          storePath: params.target.storePath,
          onPruned: (key) => {
            missingKeys.add(key);
          },
        })
      : 0;
  const dmScopeRetired =
    params.fixDmScope === true
      ? retireMainScopeDirectSessionEntries({
          cfg: params.cfg,
          store: previewStore,
          targetAgentId: params.target.agentId,
          activeKey: params.activeKey,
          onRetired: (key) => {
            dmScopeRetiredKeys.add(key);
          },
        })
      : 0;
  const preserveSessionKeys = collectSessionMaintenancePreserveKeys([params.activeKey]);
  const pruned = pruneStaleEntries(previewStore, params.maintenance.pruneAfterMs, {
    log: false,
    preserveKeys: preserveSessionKeys,
    onPruned: ({ key }) => {
      staleKeys.add(key);
    },
  });
  const capped = capEntryCount(previewStore, params.maintenance.maxEntries, {
    log: false,
    preserveKeys: preserveSessionKeys,
    onCapped: ({ key }) => {
      cappedKeys.add(key);
    },
  });
  const entryCleanupArtifactPaths = new Set<string>();
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: staleKeys,
  });
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: cappedKeys,
  });
  addEntryArtifactPathsToSet({
    paths: entryCleanupArtifactPaths,
    store: beforeStore,
    storePath: params.target.storePath,
    keys: dmScopeRetiredKeys,
  });
  const beforeBudgetStore = cloneSessionStoreRecord(previewStore);
  const budgetRemovedFilePaths = new Set<string>();
  const diskBudget = await enforceSessionDiskBudget({
    store: previewStore,
    storePath: params.target.storePath,
    activeSessionKey: params.activeKey,
    preserveKeys: preserveSessionKeys,
    maintenance: params.maintenance,
    warnOnly: false,
    dryRun: true,
    onRemoveFile: (canonicalPath) => {
      budgetRemovedFilePaths.add(canonicalPath);
    },
  });
  const unreferencedArtifacts = await pruneUnreferencedSessionArtifacts({
    store: previewStore,
    storePath: params.target.storePath,
    olderThanMs: params.maintenance.pruneAfterMs,
    dryRun: true,
    excludeCanonicalPaths: new Set([...budgetRemovedFilePaths, ...entryCleanupArtifactPaths]),
  });
  const budgetEvictedKeys = new Set<string>();
  for (const key of Object.keys(beforeBudgetStore)) {
    if (!Object.hasOwn(previewStore, key)) {
      budgetEvictedKeys.add(key);
    }
  }
  // Build the simulated post-cleanup session-id set from `previewStore` so
  // dry-run orphan-checkpoint detection matches `--enforce` (which would have
  // already pruned/capped/evicted those entries before scanning archives).
  const simulatedReferencedIds = new Set<string>();
  for (const entry of Object.values(previewStore)) {
    const id = entry?.sessionId;
    if (typeof id === "string" && id.length > 0) {
      simulatedReferencedIds.add(id);
    }
  }
  const archivedFiles = planArchivedSessionFileCleanup({
    storePath: params.target.storePath,
    pruneAfterMs: maintenance.pruneAfterMs,
    resetArchiveRetentionMs: maintenance.resetArchiveRetentionMs,
    dryRun: true,
    referencedSessionIds: simulatedReferencedIds,
  });
  const beforeCount = Object.keys(beforeStore).length;
  const afterPreviewCount = Object.keys(previewStore).length;
  const wouldMutate =
    missing > 0 ||
    dmScopeRetired > 0 ||
    pruned > 0 ||
    capped > 0 ||
    unreferencedArtifacts.removedFiles > 0 ||
    (diskBudget?.removedEntries ?? 0) > 0 ||
    (diskBudget?.removedFiles ?? 0) > 0 ||
    archivedFiles.removedDeleted > 0 ||
    archivedFiles.removedReset > 0 ||
    archivedFiles.removedOrphanCheckpoint > 0;

  const summary: SessionCleanupSummary = {
    agentId: params.target.agentId,
    storePath: params.target.storePath,
    mode: params.mode,
    dryRun: params.dryRun,
    beforeCount,
    afterCount: afterPreviewCount,
    missing,
    dmScopeRetired,
    pruned,
    capped,
    unreferencedArtifacts,
    diskBudget,
    archivedFiles,
    wouldMutate,
  };

  return {
    summary,
    beforeStore,
    missingKeys,
    staleKeys,
    cappedKeys,
    budgetEvictedKeys,
    dmScopeRetiredKeys,
  };
}

export async function runSessionsCleanup(params: {
  cfg: OpenClawConfig;
  opts: SessionsCleanupOptions;
  targets?: SessionStoreTarget[];
}): Promise<SessionsCleanupRunResult> {
  const { cfg, opts } = params;
  const maintenance = resolveMaintenanceConfig();
  const mode = opts.enforce ? "enforce" : maintenance.mode;
  const targets =
    params.targets ??
    resolveSessionStoreTargets(cfg, {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    });

  const previewResults: SessionsCleanupRunResult["previewResults"] = [];
  for (const target of targets) {
    const result = await previewStoreCleanup({
      cfg,
      target,
      maintenance,
      mode,
      dryRun: Boolean(opts.dryRun),
      activeKey: opts.activeKey,
      fixMissing: Boolean(opts.fixMissing),
      fixDmScope: Boolean(opts.fixDmScope),
    });
    previewResults.push(result);
  }

  const appliedSummaries: SessionCleanupSummary[] = [];
  if (!opts.dryRun) {
    for (const target of targets) {
      const appliedReportRef: { current: SessionMaintenanceApplyReport | null } = {
        current: null,
      };
      const dmScopeRemovedSessionFiles = new Map<string, string | undefined>();
      let missingApplied = 0;
      let dmScopeRetiredApplied = 0;
      await updateSessionStore(
        target.storePath,
        async (store) => {
          let removed = 0;
          if (opts.fixMissing) {
            missingApplied = pruneMissingTranscriptEntries({
              store,
              storePath: target.storePath,
            });
            removed += missingApplied;
          }
          if (opts.fixDmScope) {
            dmScopeRetiredApplied = retireMainScopeDirectSessionEntries({
              cfg,
              store,
              targetAgentId: target.agentId,
              activeKey: opts.activeKey,
              onRetired: (_key, entry) => {
                rememberRemovedSessionFile(dmScopeRemovedSessionFiles, entry);
              },
            });
            removed += dmScopeRetiredApplied;
          }
          return removed;
        },
        {
          activeSessionKey: opts.activeKey,
          maintenanceOverride: {
            mode,
          },
          onMaintenanceApplied: (report) => {
            appliedReportRef.current = report;
          },
        },
      );
      if (dmScopeRemovedSessionFiles.size > 0) {
        const storeAfterDmScopeRetire = loadSessionStore(target.storePath, { skipCache: true });
        await archiveRemovedSessionTranscripts({
          removedSessionFiles: dmScopeRemovedSessionFiles,
          referencedSessionIds: new Set(
            Object.values(storeAfterDmScopeRetire)
              .map((entry) => entry?.sessionId)
              .filter((id): id is string => Boolean(id)),
          ),
          storePath: target.storePath,
          reason: "deleted",
          restrictToStoreDir: true,
        });
      }
      const afterStore = loadSessionStore(target.storePath, { skipCache: true });
      const unreferencedArtifacts =
        mode === "warn"
          ? {
              scannedFiles: 0,
              removedFiles: 0,
              freedBytes: 0,
              olderThanMs: maintenance.pruneAfterMs,
            }
          : await pruneUnreferencedSessionArtifacts({
              store: afterStore,
              storePath: target.storePath,
              olderThanMs: maintenance.pruneAfterMs,
              dryRun: false,
            });
      const preview = previewResults.find(
        (result) => result.summary.storePath === target.storePath,
      );
      const appliedReport = appliedReportRef.current;
      const enforceMaintenance = resolveMaintenanceConfig();
      const archivedFiles = planArchivedSessionFileCleanup({
        storePath: target.storePath,
        pruneAfterMs: enforceMaintenance.pruneAfterMs,
        resetArchiveRetentionMs: enforceMaintenance.resetArchiveRetentionMs,
        dryRun: false,
      });
      const summary: SessionCleanupSummary =
        appliedReport === null
          ? {
              ...(preview?.summary ?? {
                agentId: target.agentId,
                storePath: target.storePath,
                mode,
                dryRun: false,
                beforeCount: 0,
                afterCount: 0,
                missing: 0,
                dmScopeRetired: 0,
                pruned: 0,
                capped: 0,
                unreferencedArtifacts,
                diskBudget: null,
                archivedFiles: emptyArchivedFilesPlan(),
                wouldMutate: false,
              }),
              archivedFiles,
              dryRun: false,
              unreferencedArtifacts,
              wouldMutate:
                (preview?.summary.wouldMutate ?? false) || unreferencedArtifacts.removedFiles > 0,
              applied: true,
              appliedCount: Object.keys(afterStore).length,
            }
          : {
              agentId: target.agentId,
              storePath: target.storePath,
              mode: appliedReport.mode,
              dryRun: false,
              beforeCount: appliedReport.beforeCount,
              afterCount: appliedReport.afterCount,
              missing: missingApplied,
              dmScopeRetired: dmScopeRetiredApplied,
              pruned: appliedReport.pruned,
              capped: appliedReport.capped,
              unreferencedArtifacts,
              diskBudget: appliedReport.diskBudget,
              archivedFiles,
              wouldMutate:
                missingApplied > 0 ||
                dmScopeRetiredApplied > 0 ||
                appliedReport.pruned > 0 ||
                appliedReport.capped > 0 ||
                unreferencedArtifacts.removedFiles > 0 ||
                (appliedReport.diskBudget?.removedEntries ?? 0) > 0 ||
                (appliedReport.diskBudget?.removedFiles ?? 0) > 0 ||
                archivedFiles.removedDeleted > 0 ||
                archivedFiles.removedReset > 0 ||
                archivedFiles.removedOrphanCheckpoint > 0,
              applied: true,
              appliedCount: Object.keys(afterStore).length,
            };
      appliedSummaries.push(summary);
    }
  }

  return { mode, previewResults, appliedSummaries };
}

/** Purge session store entries for a deleted agent (#65524). Best-effort. */
export async function purgeAgentSessionStoreEntries(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<void> {
  try {
    const normalizedAgentId = normalizeAgentId(agentId);
    const storeConfig = cfg.session?.store;
    const storeAgentId =
      typeof storeConfig === "string" && storeConfig.includes("{agentId}")
        ? normalizedAgentId
        : normalizeAgentId(resolveDefaultAgentId(cfg));
    const storePath = resolveStorePath(cfg.session?.store, { agentId: normalizedAgentId });
    await updateSessionStore(storePath, (store) => {
      for (const key of Object.keys(store)) {
        if (
          resolveStoredSessionOwnerAgentId({
            cfg,
            agentId: storeAgentId,
            sessionKey: key,
          }) === normalizedAgentId
        ) {
          delete store[key];
        }
      }
    });
  } catch (err) {
    getLogger().debug("session store purge skipped during agent delete", err);
  }
}
