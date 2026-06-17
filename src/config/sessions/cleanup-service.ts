// Session cleanup service for store entries and transcript/artifact files.
// Supports dry-run/apply modes, stale pruning, missing transcript fixes, DM-scope retirement, and disk budgets.

import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import { getLogger } from "../../logging/logger.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
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
  MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS,
  resolveSessionCleanupCandidateAge,
} from "./maintenance-age.js";
import {
  capEntryCount,
  isProtectedMainOrDirectSessionMaintenanceEntry,
  isSyntheticSessionMaintenanceKey,
  pruneStaleEntries,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
  updateSessionStore,
  type SessionMaintenanceApplyReport,
} from "./store.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
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
  syntheticOnly?: boolean;
  protectMain?: boolean;
};

export type SessionCleanupAction =
  | "keep"
  | "prune-missing"
  | "prune-stale"
  | "cap-overflow"
  | "evict-budget"
  | "retire-dm-scope";

export type SessionCleanupCandidateActionCounts = {
  "prune-missing": number;
  "retire-dm-scope": number;
  "prune-stale": number;
  "cap-overflow": number;
  "evict-budget": number;
  "prune-unreferenced-artifact": number;
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
  minCandidateAgeMs: number;
  underAgePreservedCount: number;
  ageUnknownQuarantineCount: number;
  candidateCounts: {
    preserve: number;
    archive_candidate: number;
    blocked: number;
    quarantine_review: number;
  };
  candidateActionCounts: SessionCleanupCandidateActionCounts;
  safety: {
    syntheticOnly: boolean;
    protectMain: boolean;
    protectedMainCount: number;
    protectedDirectCount: number;
    protectedMainAgentIds: string[];
    syntheticOnlyPreservedCount: number;
    blockedCount: number;
    quarantineCount: number;
  };
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

const EMPTY_TRANSCRIPT_MAX_BYTES = 4096;

function collectCleanupPolicyPreserveKeys(params: {
  store: Record<string, SessionEntry>;
  syntheticOnly?: boolean;
  protectMain?: boolean;
}): {
  keys: Set<string>;
  protectedMainCount: number;
  protectedDirectCount: number;
  protectedMainAgentIds: string[];
  syntheticOnlyPreservedCount: number;
} {
  const keys = new Set<string>();
  let protectedMainCount = 0;
  let protectedDirectCount = 0;
  const protectedMainAgentIds = new Set<string>();
  let syntheticOnlyPreservedCount = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    let preserve = false;
    if (params.syntheticOnly === true && !isSyntheticSessionMaintenanceKey(key)) {
      preserve = true;
      syntheticOnlyPreservedCount += 1;
    }
    if (isProtectedMainOrDirectSessionMaintenanceEntry(key, entry)) {
      preserve = true;
      const parsed = parseAgentSessionKey(key);
      if (parsed && parsed.rest.toLowerCase() === "main") {
        protectedMainCount += 1;
        protectedMainAgentIds.add(normalizeAgentId(parsed.agentId));
      } else {
        protectedDirectCount += 1;
      }
    }
    if (preserve) {
      keys.add(key);
    }
  }
  return {
    keys,
    protectedMainCount,
    protectedDirectCount,
    protectedMainAgentIds: [...protectedMainAgentIds].toSorted(),
    syntheticOnlyPreservedCount,
  };
}

function collectCleanupPreserveKeys(params: {
  activeKey?: string;
  policyPreserveKeys?: Iterable<string>;
}): Set<string> | undefined {
  return collectSessionMaintenancePreserveKeys([
    params.activeKey,
    ...(params.policyPreserveKeys ?? []),
  ]);
}

function hasPreservedSessionKey(
  preserveKeys: ReadonlySet<string> | undefined,
  key: string,
): boolean {
  return (
    preserveKeys?.has(key) === true ||
    preserveKeys?.has(normalizeStoreSessionKey(key)) === true
  );
}

function emptyUnreferencedArtifactSweepResult(
  olderThanMs: number,
): SessionUnreferencedArtifactSweepResult {
  return {
    scannedFiles: 0,
    removedFiles: 0,
    freedBytes: 0,
    olderThanMs,
  };
}

function isTranscriptMessageRole(role: unknown): boolean {
  return (
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "toolResult" ||
    role === "system"
  );
}

function isTranscriptMessageRecord(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as { message?: unknown; role?: unknown; type?: unknown };
  if (record.type === "message") {
    return true;
  }
  if (
    record.type === undefined &&
    record.message &&
    typeof record.message === "object" &&
    isTranscriptMessageRole((record.message as { role?: unknown }).role)
  ) {
    return true;
  }
  return record.type === undefined && isTranscriptMessageRole(record.role);
}

function transcriptHasNoMessageRecords(transcriptPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > EMPTY_TRANSCRIPT_MAX_BYTES) {
    // Only inspect small transcript files; larger files are assumed to contain real history.
    return false;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return false;
  }

  const lines = raw.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return true;
  }
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      return false;
    }
    if (isTranscriptMessageRecord(entry)) {
      return false;
    }
  }
  return true;
}

/** Resolves the action label for one session key from cleanup key sets. */
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

function buildCandidateActionCounts(params: {
  missing: number;
  dmScopeRetired: number;
  pruned: number;
  capped: number;
  diskBudgetRemovedEntries?: number;
  unreferencedArtifactFiles?: number;
}): SessionCleanupCandidateActionCounts {
  return {
    "prune-missing": params.missing,
    "retire-dm-scope": params.dmScopeRetired,
    "prune-stale": params.pruned,
    "cap-overflow": params.capped,
    "evict-budget": params.diskBudgetRemovedEntries ?? 0,
    "prune-unreferenced-artifact": params.unreferencedArtifactFiles ?? 0,
  };
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
  preserveKeys?: ReadonlySet<string>;
  onRetired?: (key: string, entry: SessionEntry) => void;
  onPreservedUnderAge?: (key: string) => void;
  onQuarantinedAge?: (key: string) => void;
  nowMs?: number;
}): number {
  let retired = 0;
  const nowMs = params.nowMs ?? Date.now();
  for (const [key, entry] of Object.entries(params.store)) {
    if (hasPreservedSessionKey(params.preserveKeys, key)) {
      continue;
    }
    if (
      isMainScopeStaleDirectSessionKey({
        cfg: params.cfg,
        targetAgentId: params.targetAgentId,
        key,
        activeKey: params.activeKey,
      })
    ) {
      const age = resolveSessionCleanupCandidateAge({ entry, nowMs });
      if (!age.eligible) {
        if (age.reason === "under-age") {
          params.onPreservedUnderAge?.(key);
        } else {
          params.onQuarantinedAge?.(key);
        }
        continue;
      }
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

function pruneMissingTranscriptEntries(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  preserveKeys?: ReadonlySet<string>;
  onPruned?: (key: string) => void;
  onPreservedUnderAge?: (key: string) => void;
  onQuarantinedAge?: (key: string) => void;
  nowMs?: number;
}): number {
  const sessionPathOpts = resolveSessionFilePathOptions({
    storePath: params.storePath,
  });
  const nowMs = params.nowMs ?? Date.now();
  let removed = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    if (hasPreservedSessionKey(params.preserveKeys, key)) {
      continue;
    }
    if (!entry?.sessionId) {
      if (parseAgentSessionKey(key)) {
        // Agent-scoped keys without session ids are valid routing entries; keep them.
        continue;
      }
      const age = resolveSessionCleanupCandidateAge({ entry, nowMs });
      if (!age.eligible) {
        if (age.reason === "under-age") {
          params.onPreservedUnderAge?.(key);
        } else {
          params.onQuarantinedAge?.(key);
        }
        continue;
      }
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key);
      continue;
    }
    let transcriptPath: string | undefined;
    try {
      transcriptPath = resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts);
    } catch {
      // Malformed legacy rows cannot resolve a transcript path; --fix-missing prunes them.
    }
    if (
      !transcriptPath ||
      !fs.existsSync(transcriptPath) ||
      transcriptHasNoMessageRecords(transcriptPath)
    ) {
      const age = resolveSessionCleanupCandidateAge({ entry, nowMs });
      if (!age.eligible) {
        if (age.reason === "under-age") {
          params.onPreservedUnderAge?.(key);
        } else {
          params.onQuarantinedAge?.(key);
        }
        continue;
      }
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
  syntheticOnly?: boolean;
  protectMain?: boolean;
}) {
  const beforeStore = loadSessionStore(params.target.storePath, { skipCache: true });
  // Preview always mutates a clone so dry-run output can report exact counts without touching disk.
  const previewStore = cloneSessionStoreRecord(beforeStore);
  const policyPreserve = collectCleanupPolicyPreserveKeys({
    store: beforeStore,
    syntheticOnly: params.syntheticOnly,
    protectMain: params.protectMain,
  });
  const preserveSessionKeys = collectCleanupPreserveKeys({
    activeKey: params.activeKey,
    policyPreserveKeys: policyPreserve.keys,
  });
  const staleKeys = new Set<string>();
  const cappedKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const dmScopeRetiredKeys = new Set<string>();
  const underAgePreservedKeys = new Set<string>();
  const ageUnknownQuarantineKeys = new Set<string>();
  const nowMs = Date.now();
  const missing =
    params.fixMissing === true
      ? pruneMissingTranscriptEntries({
          store: previewStore,
          storePath: params.target.storePath,
          preserveKeys: preserveSessionKeys,
          nowMs,
          onPruned: (key) => {
            missingKeys.add(key);
          },
          onPreservedUnderAge: (key) => {
            underAgePreservedKeys.add(key);
          },
          onQuarantinedAge: (key) => {
            ageUnknownQuarantineKeys.add(key);
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
          preserveKeys: preserveSessionKeys,
          nowMs,
          onRetired: (key) => {
            dmScopeRetiredKeys.add(key);
          },
          onPreservedUnderAge: (key) => {
            underAgePreservedKeys.add(key);
          },
          onQuarantinedAge: (key) => {
            ageUnknownQuarantineKeys.add(key);
          },
        })
      : 0;
  const pruned = pruneStaleEntries(previewStore, params.maintenance.pruneAfterMs, {
    log: false,
    preserveKeys: preserveSessionKeys,
    nowMs,
    onPruned: ({ key }) => {
      staleKeys.add(key);
    },
    onQuarantinedAge: ({ key }) => {
      ageUnknownQuarantineKeys.add(key);
    },
  });
  const capped = capEntryCount(previewStore, params.maintenance.maxEntries, {
    log: false,
    preserveKeys: preserveSessionKeys,
    onCapped: ({ key }) => {
      cappedKeys.add(key);
    },
    onPreservedUnderAge: ({ key }) => {
      underAgePreservedKeys.add(key);
    },
    onQuarantinedAge: ({ key }) => {
      ageUnknownQuarantineKeys.add(key);
    },
    nowMs,
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
    skipUnclassifiedArtifacts: params.syntheticOnly === true,
    onRemoveFile: (canonicalPath) => {
      budgetRemovedFilePaths.add(canonicalPath);
    },
    onPreservedUnderAgeEntry: (key) => {
      underAgePreservedKeys.add(key);
    },
    onQuarantinedAgeEntry: (key) => {
      ageUnknownQuarantineKeys.add(key);
    },
  });
  const unreferencedArtifacts =
    params.syntheticOnly === true
      ? emptyUnreferencedArtifactSweepResult(params.maintenance.pruneAfterMs)
      : await pruneUnreferencedSessionArtifacts({
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
  const beforeCount = Object.keys(beforeStore).length;
  const afterPreviewCount = Object.keys(previewStore).length;
  const blockedCount =
    (afterPreviewCount > params.maintenance.maxEntries ? 1 : 0) +
    (diskBudget && diskBudget.totalBytesAfter > diskBudget.highWaterBytes ? 1 : 0);
  const wouldMutate =
    missing > 0 ||
    dmScopeRetired > 0 ||
    pruned > 0 ||
    capped > 0 ||
    unreferencedArtifacts.removedFiles > 0 ||
    (diskBudget?.removedEntries ?? 0) > 0 ||
    (diskBudget?.removedFiles ?? 0) > 0;
  const archiveCandidateCount =
    missing +
    dmScopeRetired +
    pruned +
    capped +
    unreferencedArtifacts.removedFiles +
    (diskBudget?.removedEntries ?? 0);

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
    minCandidateAgeMs: MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS,
    underAgePreservedCount: underAgePreservedKeys.size,
    ageUnknownQuarantineCount: ageUnknownQuarantineKeys.size,
    candidateCounts: {
      preserve: afterPreviewCount,
      archive_candidate: archiveCandidateCount,
      blocked: blockedCount,
      quarantine_review: ageUnknownQuarantineKeys.size,
    },
    candidateActionCounts: buildCandidateActionCounts({
      missing,
      dmScopeRetired,
      pruned,
      capped,
      diskBudgetRemovedEntries: diskBudget?.removedEntries ?? 0,
      unreferencedArtifactFiles: unreferencedArtifacts.removedFiles,
    }),
    safety: {
      syntheticOnly: params.syntheticOnly === true,
      protectMain: true,
      protectedMainCount: policyPreserve.protectedMainCount,
      protectedDirectCount: policyPreserve.protectedDirectCount,
      protectedMainAgentIds: policyPreserve.protectedMainAgentIds,
      syntheticOnlyPreservedCount: policyPreserve.syntheticOnlyPreservedCount,
      blockedCount,
      quarantineCount: ageUnknownQuarantineKeys.size,
    },
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

/** Runs session cleanup preview/apply for the selected store targets. */
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
      syntheticOnly: Boolean(opts.syntheticOnly),
      protectMain: Boolean(opts.protectMain),
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
      const beforeStoreForPolicy = loadSessionStore(target.storePath, { skipCache: true });
      const policyPreserve = collectCleanupPolicyPreserveKeys({
        store: beforeStoreForPolicy,
        syntheticOnly: opts.syntheticOnly,
        protectMain: opts.protectMain,
      });
      const preserveSessionKeys = collectCleanupPreserveKeys({
        activeKey: opts.activeKey,
        policyPreserveKeys: policyPreserve.keys,
      });
      const nowMs = Date.now();
      await updateSessionStore(
        target.storePath,
        async (store) => {
          let removed = 0;
          if (opts.fixMissing) {
            missingApplied = pruneMissingTranscriptEntries({
              store,
              storePath: target.storePath,
              preserveKeys: preserveSessionKeys,
              nowMs,
            });
            removed += missingApplied;
          }
          if (opts.fixDmScope) {
            // DM-scope retirement removes stale main-scope direct entries during apply.
            dmScopeRetiredApplied = retireMainScopeDirectSessionEntries({
              cfg,
              store,
              targetAgentId: target.agentId,
              activeKey: opts.activeKey,
              preserveKeys: preserveSessionKeys,
              nowMs,
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
          maintenancePreserveKeys: policyPreserve.keys,
          maintenanceSkipUnclassifiedArtifacts: opts.syntheticOnly === true,
          maintenanceOverride: {
            mode,
          },
          onMaintenanceApplied: (report) => {
            appliedReportRef.current = report;
          },
        },
      );
      if (dmScopeRemovedSessionFiles.size > 0) {
        // Archive removed direct-session transcripts unless still referenced by surviving entries.
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
        mode === "warn" || opts.syntheticOnly === true
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
                minCandidateAgeMs: MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS,
                underAgePreservedCount: 0,
                ageUnknownQuarantineCount: 0,
                candidateCounts: {
                  preserve: 0,
                  archive_candidate: 0,
                  blocked: 0,
                  quarantine_review: 0,
                },
                candidateActionCounts: buildCandidateActionCounts({
                  missing: 0,
                  dmScopeRetired: 0,
                  pruned: 0,
                  capped: 0,
                  diskBudgetRemovedEntries: 0,
                  unreferencedArtifactFiles: unreferencedArtifacts.removedFiles,
                }),
                safety: {
        syntheticOnly: opts.syntheticOnly === true,
                protectMain: true,
                  protectedMainCount: policyPreserve.protectedMainCount,
                  protectedDirectCount: policyPreserve.protectedDirectCount,
                  protectedMainAgentIds: policyPreserve.protectedMainAgentIds,
                  syntheticOnlyPreservedCount: policyPreserve.syntheticOnlyPreservedCount,
                  blockedCount: 0,
                  quarantineCount: 0,
                },
                wouldMutate: false,
              }),
              dryRun: false,
              unreferencedArtifacts,
              minCandidateAgeMs:
                preview?.summary.minCandidateAgeMs ?? MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS,
              underAgePreservedCount: preview?.summary.underAgePreservedCount ?? 0,
              ageUnknownQuarantineCount: preview?.summary.ageUnknownQuarantineCount ?? 0,
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
              minCandidateAgeMs:
                preview?.summary.minCandidateAgeMs ?? MIN_SESSION_CLEANUP_CANDIDATE_AGE_MS,
              underAgePreservedCount: preview?.summary.underAgePreservedCount ?? 0,
              ageUnknownQuarantineCount: preview?.summary.ageUnknownQuarantineCount ?? 0,
              candidateCounts: {
                preserve: appliedReport.afterCount,
                archive_candidate:
                  missingApplied +
                  dmScopeRetiredApplied +
                  appliedReport.pruned +
                  appliedReport.capped +
                  unreferencedArtifacts.removedFiles +
                  (appliedReport.diskBudget?.removedEntries ?? 0),
                blocked: preview?.summary.candidateCounts.blocked ?? 0,
                quarantine_review: preview?.summary.candidateCounts.quarantine_review ?? 0,
              },
              candidateActionCounts: buildCandidateActionCounts({
                missing: missingApplied,
                dmScopeRetired: dmScopeRetiredApplied,
                pruned: appliedReport.pruned,
                capped: appliedReport.capped,
                diskBudgetRemovedEntries: appliedReport.diskBudget?.removedEntries ?? 0,
                unreferencedArtifactFiles: unreferencedArtifacts.removedFiles,
              }),
              safety: {
                syntheticOnly: opts.syntheticOnly === true,
                protectMain: true,
                protectedMainCount: policyPreserve.protectedMainCount,
                protectedDirectCount: policyPreserve.protectedDirectCount,
                protectedMainAgentIds: policyPreserve.protectedMainAgentIds,
                syntheticOnlyPreservedCount: policyPreserve.syntheticOnlyPreservedCount,
                blockedCount: preview?.summary.safety.blockedCount ?? 0,
                quarantineCount: preview?.summary.safety.quarantineCount ?? 0,
              },
              wouldMutate:
                missingApplied > 0 ||
                dmScopeRetiredApplied > 0 ||
                appliedReport.pruned > 0 ||
                appliedReport.capped > 0 ||
                unreferencedArtifacts.removedFiles > 0 ||
                (appliedReport.diskBudget?.removedEntries ?? 0) > 0 ||
                (appliedReport.diskBudget?.removedFiles ?? 0) > 0,
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
