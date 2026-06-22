/** Session update helpers for skill snapshots, compaction, and lifecycle hooks. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { resolveCompactionSessionFile, type SessionEntry } from "../../config/sessions.js";
import { patchSessionEntry, upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import { resolveStableSessionEndTranscript } from "../../gateway/session-transcript-files.fs.js";
import { logVerbose } from "../../globals.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";
export { drainFormattedSystemEvents } from "./session-system-events.js";
export { resetResolvedSkillsCacheForTests } from "../../skills/runtime/session-snapshot.js";

async function persistSessionEntryUpdate(params: {
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  nextEntry: SessionEntry;
}) {
  if (!params.sessionStore || !params.sessionKey) {
    return;
  }
  params.sessionStore[params.sessionKey] = {
    ...params.sessionStore[params.sessionKey],
    ...params.nextEntry,
  };
  if (!params.storePath) {
    return;
  }
  await upsertSessionEntry(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    params.nextEntry,
  );
}

function emitCompactionSessionLifecycleHooks(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  previousEntry: SessionEntry;
  nextEntry: SessionEntry;
}) {
  if (params.previousEntry.sessionId) {
    forgetActiveSessionForShutdown(params.previousEntry.sessionId);
  }
  if (params.nextEntry.sessionId && params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.nextEntry.sessionId,
      storePath: params.storePath,
      sessionFile: params.nextEntry.sessionFile,
      agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return;
  }

  if (hookRunner.hasHooks("session_end")) {
    const transcript = resolveStableSessionEndTranscript({
      sessionId: params.previousEntry.sessionId,
      storePath: params.storePath,
      sessionFile: params.previousEntry.sessionFile,
      agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    });
    const payload = buildSessionEndHookPayload({
      sessionId: params.previousEntry.sessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      reason: "compaction",
      sessionFile: transcript.sessionFile,
      transcriptArchived: transcript.transcriptArchived,
      nextSessionId: params.nextEntry.sessionId,
    });
    void hookRunner.runSessionEnd(payload.event, payload.context).catch((err: unknown) => {
      logVerbose(`session_end hook failed: ${String(err)}`);
    });
  }

  if (hookRunner.hasHooks("session_start")) {
    const payload = buildSessionStartHookPayload({
      sessionId: params.nextEntry.sessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      resumedFrom: params.previousEntry.sessionId,
    });
    void hookRunner.runSessionStart(payload.event, payload.context).catch((err: unknown) => {
      logVerbose(`session_start hook failed: ${String(err)}`);
    });
  }
}

function resolveNonNegativeTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** Ensures a session entry has the reusable skill snapshot needed for reply runs. */
export async function ensureSkillSnapshot(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  isFirstTurnInSession: boolean;
  workspaceDir: string;
  cfg: OpenClawConfig;
  /** If provided, only load skills with these names (for per-channel skill filtering) */
  skillFilter?: string[];
}): Promise<{
  sessionEntry?: SessionEntry;
  skillsSnapshot?: SessionEntry["skillsSnapshot"];
  systemSent: boolean;
}> {
  if (process.env.OPENCLAW_TEST_FAST === "1") {
    // In fast unit-test runs we skip filesystem scanning, watchers, and session-store writes.
    // Dedicated skills tests cover snapshot generation behavior.
    return {
      sessionEntry: params.sessionEntry,
      skillsSnapshot: params.sessionEntry?.skillsSnapshot,
      systemSent: params.sessionEntry?.systemSent ?? false,
    };
  }

  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter,
  } = params;

  let nextEntry = sessionEntry;
  let systemSent = sessionEntry?.systemSent ?? false;
  const sessionAgentId = resolveSessionAgentId({ sessionKey, config: cfg });
  const remoteEligibility = getRemoteSkillEligibility({
    advertiseExecNode: canExecRequestNode({
      cfg,
      sessionEntry,
      sessionKey,
      agentId: sessionAgentId,
    }),
  });
  const existingSnapshot = nextEntry?.skillsSnapshot;
  const resolveSnapshot = (snapshot: SessionEntry["skillsSnapshot"]) =>
    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir,
      config: cfg,
      agentId: sessionAgentId,
      skillFilter,
      eligibility: { remote: remoteEligibility },
      existingSnapshot: snapshot,
    });
  const initialSnapshotState = resolveSnapshot(existingSnapshot);
  const shouldRefreshSnapshot = initialSnapshotState.shouldRefresh;

  if (isFirstTurnInSession && sessionStore && sessionKey) {
    const current = nextEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      !current.skillsSnapshot || shouldRefreshSnapshot
        ? initialSnapshotState.snapshot
        : resolveSnapshot(current.skillsSnapshot).snapshot;
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: skillSnapshot,
    };
    await persistSessionEntryUpdate({ sessionStore, sessionKey, storePath, nextEntry });
    systemSent = true;
  }

  const hasFreshSnapshotInEntry =
    Boolean(nextEntry?.skillsSnapshot) &&
    (nextEntry?.skillsSnapshot !== existingSnapshot || !shouldRefreshSnapshot);
  const skillsSnapshot =
    hasFreshSnapshotInEntry && nextEntry?.skillsSnapshot
      ? resolveSnapshot(nextEntry.skillsSnapshot).snapshot
      : shouldRefreshSnapshot || !nextEntry?.skillsSnapshot
        ? initialSnapshotState.snapshot
        : resolveSnapshot(nextEntry.skillsSnapshot).snapshot;
  if (
    skillsSnapshot &&
    sessionStore &&
    sessionKey &&
    !isFirstTurnInSession &&
    (!nextEntry?.skillsSnapshot || shouldRefreshSnapshot)
  ) {
    const current = nextEntry ?? {
      sessionId: sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    await persistSessionEntryUpdate({ sessionStore, sessionKey, storePath, nextEntry });
  }

  return { sessionEntry: nextEntry, skillsSnapshot, systemSent };
}

/** Increments compaction count and persists the updated session entry. */
export async function incrementCompactionCount(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  cfg?: OpenClawConfig;
  now?: number;
  amount?: number;
  /** Token count after compaction - if provided, updates session token counts */
  tokensAfter?: number;
  /** Session id after compaction, when the runtime rotated transcripts. */
  newSessionId?: string;
  /** Session file after compaction, when the runtime rotated transcripts. */
  newSessionFile?: string;
  /** Last byte-triggered preflight compaction active transcript size, in bytes. */
  transcriptBytesCompactionBytes?: number;
  /** Byte threshold used for the last byte-triggered preflight compaction. */
  transcriptBytesCompactionThreshold?: number;
  /** Session file produced/kept by the last byte-triggered preflight compaction. */
  transcriptBytesCompactionSessionFile?: string;
  /** Timestamp (ms) of the last byte-triggered preflight compaction. */
  transcriptBytesCompactionAt?: number;
}): Promise<number | undefined> {
  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    cfg,
    now = Date.now(),
    amount = 1,
    tokensAfter,
    newSessionId,
    newSessionFile,
    transcriptBytesCompactionBytes,
    transcriptBytesCompactionThreshold,
    transcriptBytesCompactionSessionFile,
    transcriptBytesCompactionAt,
  } = params;
  if (!sessionStore || !sessionKey) {
    return undefined;
  }
  const entry = sessionStore[sessionKey] ?? sessionEntry;
  if (!entry) {
    return undefined;
  }
  const incrementBy = Math.max(0, amount);
  const nextCount = (entry.compactionCount ?? 0) + incrementBy;
  // Build update payload with compaction count and optionally updated token counts
  const updates: Partial<SessionEntry> = {
    compactionCount: nextCount,
    updatedAt: now,
  };
  const explicitNewSessionFile = normalizeOptionalString(newSessionFile);
  const sessionIdChanged = Boolean(newSessionId && newSessionId !== entry.sessionId);
  const sessionFileChanged = Boolean(
    explicitNewSessionFile && explicitNewSessionFile !== entry.sessionFile,
  );
  if (sessionIdChanged && newSessionId) {
    updates.sessionId = newSessionId;
    updates.sessionFile =
      explicitNewSessionFile ??
      resolveCompactionSessionFile({
        entry,
        sessionKey,
        storePath,
        newSessionId,
      });
    updates.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
    updates.usageFamilySessionIds = Array.from(
      new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId, newSessionId]),
    );
  } else if (sessionFileChanged && explicitNewSessionFile) {
    updates.sessionFile = explicitNewSessionFile;
  }
  // If tokensAfter is provided, update the cached token counts to reflect post-compaction state
  const tokensAfterCompaction = resolveNonNegativeTokenCount(tokensAfter);
  if (tokensAfterCompaction !== undefined) {
    updates.totalTokens = tokensAfterCompaction;
    updates.totalTokensFresh = true;
    // Clear input/output breakdown since we only have the total estimate after compaction
    updates.inputTokens = undefined;
    updates.outputTokens = undefined;
    updates.cacheRead = undefined;
    updates.cacheWrite = undefined;
  } else if (incrementBy > 0) {
    updates.totalTokensFresh = false;
  }
  const normalizedTranscriptBytesCompactionBytes =
    typeof transcriptBytesCompactionBytes === "number" &&
    Number.isFinite(transcriptBytesCompactionBytes) &&
    transcriptBytesCompactionBytes >= 0
      ? Math.floor(transcriptBytesCompactionBytes)
      : undefined;
  const normalizedTranscriptBytesCompactionThreshold =
    typeof transcriptBytesCompactionThreshold === "number" &&
    Number.isFinite(transcriptBytesCompactionThreshold) &&
    transcriptBytesCompactionThreshold > 0
      ? Math.floor(transcriptBytesCompactionThreshold)
      : undefined;
  const normalizedTranscriptBytesCompactionAt =
    typeof transcriptBytesCompactionAt === "number" &&
    Number.isFinite(transcriptBytesCompactionAt) &&
    transcriptBytesCompactionAt > 0
      ? Math.floor(transcriptBytesCompactionAt)
      : undefined;
  if (
    normalizedTranscriptBytesCompactionBytes !== undefined &&
    normalizedTranscriptBytesCompactionThreshold !== undefined
  ) {
    updates.transcriptBytesCompactionBytes = normalizedTranscriptBytesCompactionBytes;
    updates.transcriptBytesCompactionThreshold = normalizedTranscriptBytesCompactionThreshold;
    updates.transcriptBytesCompactionSessionFile = normalizeOptionalString(
      transcriptBytesCompactionSessionFile,
    );
    updates.transcriptBytesCompactionAt = normalizedTranscriptBytesCompactionAt ?? now;
  }
  const nextEntry = {
    ...entry,
    ...updates,
  };
  sessionStore[sessionKey] = nextEntry;
  if (storePath) {
    const persistedEntry = await patchSessionEntry({ storePath, sessionKey }, () => updates, {
      fallbackEntry: nextEntry,
    });
    if (persistedEntry) {
      sessionStore[sessionKey] = persistedEntry;
    }
  }
  if ((sessionIdChanged || sessionFileChanged) && cfg) {
    emitCompactionSessionLifecycleHooks({
      cfg,
      sessionKey,
      storePath,
      previousEntry: entry,
      nextEntry: sessionStore[sessionKey],
    });
  }
  return nextCount;
}
