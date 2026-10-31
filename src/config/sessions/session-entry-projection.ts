import { clearAllCliSessions } from "./cli-session-binding.js";
import { resolveSessionCreatorActor } from "./session-entry-provenance.js";
import type { AgentPatchedSessionModelFallback } from "./session-model-fallback.js";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
  type SessionEntry,
} from "./types.js";

type RetiredSessionMetadata = {
  thinkingLevelSelection?: unknown;
  compactionCheckpoints?: unknown;
  modelFallback?: AgentPatchedSessionModelFallback & { prevThinkingLevelSelection?: unknown };
};

export const SESSION_ENTRY_PRIVATE_CLEAR_PATCH = {
  activeWriterRunId: undefined,
  lastRunId: undefined,
  lifecycleRunId: undefined,
  resumeAfterRestart: undefined,
  mainRestartRecovery: undefined,
  pendingProjectGitUrl: undefined,
  pendingWorktree: undefined,
  priorWorkspace: undefined,
  sessionDiffBaselineCapture: undefined,
  transcriptByteCompactionLatch: undefined,
} satisfies Partial<InternalSessionEntry>;

const PRIVATE_SESSION_ENTRY_KEYS = [
  "inheritedGitContributorProfileIds",
  "profileInvolvement",
  "cliHistoryBoundary",
  "publicShare",
  "activeWriterRunId",
  "lastRunId",
  "lifecycleRunId",
  "resumeAfterRestart",
  "mainRestartRecovery",
  "pendingProjectGitUrl",
  "pendingWorktree",
  "priorWorkspace",
  "sessionDiffBaselineCapture",
  "transcriptByteCompactionLatch",
] as const satisfies readonly (keyof InternalSessionEntry)[];

function stripPrivateSessionEntryFields(
  entry: InternalSessionEntry,
  identity: "public" | "execution",
): SessionEntry;
function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry>,
  identity: "public" | "execution",
): Partial<SessionEntry>;
function stripPrivateSessionEntryFields(
  entry: Partial<InternalSessionEntry> & RetiredSessionMetadata,
  identity: "public" | "execution",
): Partial<SessionEntry> {
  const projected = { ...entry };
  for (const key of PRIVATE_SESSION_ENTRY_KEYS) {
    delete projected[key];
  }
  // Existing databases may retain retired execution-recovery snapshots. Never expose them.
  for (const key of Object.keys(projected)) {
    if (
      key === "pendingExecNotifications" ||
      key === "subagentRecovery" ||
      key.startsWith("restartRecovery")
    ) {
      Reflect.deleteProperty(projected, key);
    }
  }
  if (identity === "public" && projected.createdActor) {
    projected.createdActor = resolveSessionCreatorActor(projected.createdActor);
  }
  delete projected.thinkingLevelSelection;
  delete projected.compactionCheckpoints;
  if (entry.modelFallback) {
    const { prevThinkingLevelSelection: _privateSelection, ...modelFallback } = entry.modelFallback;
    projected.modelFallback = modelFallback;
  } else {
    delete projected.modelFallback;
  }
  return projected;
}

/** Internal execution retains the immutable sandbox actor, not its display projection. */
export function projectExecutionSessionEntry(entry: InternalSessionEntry): SessionEntry {
  return stripPrivateSessionEntryFields(entry, "execution");
}

export function projectPublicSessionEntry(entry: InternalSessionEntry): SessionEntry {
  return stripPrivateSessionEntryFields(entry, "public");
}

export function projectPublicSessionEntryPatch(
  patch: Partial<InternalSessionEntry>,
): Partial<SessionEntry> {
  return stripPrivateSessionEntryFields(patch, "public");
}

// A completed context rewrite invalidates the previous run snapshot, not the transcript ledger.
export const COMPACTION_RUN_USAGE_CLEAR_PATCH = {
  usageReport: undefined,
  inputTokens: undefined,
  outputTokens: undefined,
  cacheRead: undefined,
  cacheWrite: undefined,
  estimatedCostUsd: undefined,
} satisfies Partial<InternalSessionEntry>;

export function projectCompactionAccountingPatch(
  current: InternalSessionEntry,
  params: {
    amount?: number;
    compactionKind?: "context-engine" | "native-harness" | "server-endpoint";
    now?: number;
    /** Null invalidates an earlier estimate without incrementing the boundary count. */
    tokensAfter?: number | null;
    /** Omission preserves host suppression; null clears it across the worker boundary. */
    transcriptByteCompactionLatch?: InternalSessionEntry["transcriptByteCompactionLatch"] | null;
  },
): Partial<InternalSessionEntry> {
  const incrementBy = Math.max(0, params.amount ?? 1);
  const tokensAfter =
    typeof params.tokensAfter === "number" &&
    Number.isFinite(params.tokensAfter) &&
    params.tokensAfter >= 0
      ? Math.floor(params.tokensAfter)
      : undefined;
  const patch: Partial<InternalSessionEntry> = {
    compactionCount: (current.compactionCount ?? 0) + incrementBy,
    updatedAt: params.now ?? Date.now(),
    ...(params.transcriptByteCompactionLatch !== undefined
      ? { transcriptByteCompactionLatch: params.transcriptByteCompactionLatch ?? undefined }
      : {}),
    ...(incrementBy > 0 || tokensAfter !== undefined ? COMPACTION_RUN_USAGE_CLEAR_PATCH : {}),
    ...(incrementBy > 0 ? { contextBudgetStatus: undefined } : {}),
  };
  if (params.compactionKind === "context-engine") {
    clearAllCliSessions(patch);
  }
  if (tokensAfter !== undefined) {
    Object.assign(patch, {
      totalTokens: tokensAfter,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
  } else if (incrementBy > 0 || params.tokensAfter === null) {
    patch.totalTokensFresh = false;
    patch.totalTokensVersion = undefined;
  }
  return patch;
}
