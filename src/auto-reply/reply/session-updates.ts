import crypto from "node:crypto";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { canExecRequestNode } from "../../agents/exec-defaults.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { matchesSkillFilter } from "../../agents/skills/filter.js";
import {
  getSkillsSnapshotVersion,
  shouldRefreshSnapshotForVersion,
} from "../../agents/skills/refresh-state.js";
import { ensureSkillsWatcher } from "../../agents/skills/refresh.js";
import { hydrateResolvedSkills } from "../../agents/skills/snapshot-hydration.js";
import {
  getSessionEntry,
  mergeSessionEntry,
  type SessionEntry,
  upsertSessionEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { buildSessionEndHookPayload, buildSessionStartHookPayload } from "./session-hooks.js";
export { drainFormattedSystemEvents } from "./session-system-events.js";

// nextEntry.skillsSnapshot may carry resolvedSkills (full Skill[] with
// SKILL.md bodies) for in-turn use. The SQLite session row store strips
// resolvedSkills before serializing, so the persisted row stays small. The
// in-memory params.sessionStore reference still carries the runtime cache for
// the rest of this turn.
async function persistSessionEntryUpdate(params: {
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  nextEntry: SessionEntry;
}) {
  if (!params.sessionStore || !params.sessionKey) {
    return;
  }
  params.sessionStore[params.sessionKey] = {
    ...params.sessionStore[params.sessionKey],
    ...params.nextEntry,
  };
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  if (!agentId) {
    return;
  }
  upsertSessionEntry({
    agentId,
    sessionKey: params.sessionKey,
    entry: mergeSessionEntry(getSessionEntry({ agentId, sessionKey: params.sessionKey }), {
      ...params.nextEntry,
    }),
  });
}

function emitCompactionSessionLifecycleHooks(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  previousEntry: SessionEntry;
  nextEntry: SessionEntry;
}) {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return;
  }

  if (hookRunner.hasHooks("session_end")) {
    const payload = buildSessionEndHookPayload({
      sessionId: params.previousEntry.sessionId,
      sessionKey: params.sessionKey,
      cfg: params.cfg,
      reason: "compaction",
      nextSessionId: params.nextEntry.sessionId,
    });
    void hookRunner.runSessionEnd(payload.event, payload.context).catch((err) => {
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
    void hookRunner.runSessionStart(payload.event, payload.context).catch((err) => {
      logVerbose(`session_start hook failed: ${String(err)}`);
    });
  }
}

function resolvePositiveTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export async function ensureSkillSnapshot(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
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
    // In fast unit-test runs we skip filesystem scanning, watchers, and SQLite session-row writes.
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
  const snapshotVersion = getSkillsSnapshotVersion(workspaceDir);
  const existingSnapshot = nextEntry?.skillsSnapshot;
  ensureSkillsWatcher({ workspaceDir, config: cfg });
  const shouldRefreshSnapshot =
    shouldRefreshSnapshotForVersion(existingSnapshot?.version, snapshotVersion) ||
    !matchesSkillFilter(existingSnapshot?.skillFilter, skillFilter);
  const buildSnapshot = () =>
    buildWorkspaceSkillSnapshot(workspaceDir, {
      config: cfg,
      agentId: sessionAgentId,
      skillFilter,
      eligibility: { remote: remoteEligibility },
      snapshotVersion,
    });

  if (isFirstTurnInSession && sessionStore && sessionKey) {
    const current = nextEntry ??
      sessionStore[sessionKey] ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      };
    const skillSnapshot =
      !current.skillsSnapshot || shouldRefreshSnapshot
        ? buildSnapshot()
        : hydrateResolvedSkills(current.skillsSnapshot, buildSnapshot);
    nextEntry = {
      ...current,
      sessionId: sessionId ?? current.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
      skillsSnapshot: skillSnapshot,
    };
    await persistSessionEntryUpdate({ sessionStore, sessionKey, nextEntry });
    systemSent = true;
  }

  const hasFreshSnapshotInEntry =
    Boolean(nextEntry?.skillsSnapshot) &&
    (nextEntry?.skillsSnapshot !== existingSnapshot || !shouldRefreshSnapshot);
  const skillsSnapshot =
    hasFreshSnapshotInEntry && nextEntry?.skillsSnapshot
      ? hydrateResolvedSkills(nextEntry.skillsSnapshot, buildSnapshot)
      : shouldRefreshSnapshot || !nextEntry?.skillsSnapshot
        ? buildSnapshot()
        : hydrateResolvedSkills(nextEntry.skillsSnapshot, buildSnapshot);
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
    await persistSessionEntryUpdate({ sessionStore, sessionKey, nextEntry });
  }

  return { sessionEntry: nextEntry, skillsSnapshot, systemSent };
}

export async function incrementCompactionCount(params: {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  cfg?: OpenClawConfig;
  now?: number;
  amount?: number;
  /** Token count after compaction - if provided, updates session token counts */
  tokensAfter?: number;
  /** Session id after compaction, when the runtime rotated transcripts. */
  newSessionId?: string;
}): Promise<number | undefined> {
  const {
    sessionEntry,
    sessionStore,
    sessionKey,
    cfg,
    now = Date.now(),
    amount = 1,
    tokensAfter,
    newSessionId,
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
  const sessionIdChanged = Boolean(newSessionId && newSessionId !== entry.sessionId);
  if (sessionIdChanged && newSessionId) {
    updates.sessionId = newSessionId;
    updates.usageFamilyKey = entry.usageFamilyKey ?? sessionKey;
    updates.usageFamilySessionIds = Array.from(
      new Set([...(entry.usageFamilySessionIds ?? []), entry.sessionId, newSessionId]),
    );
  }
  // If tokensAfter is provided, update the cached token counts to reflect post-compaction state
  const tokensAfterCompaction = resolvePositiveTokenCount(tokensAfter);
  if (tokensAfterCompaction !== undefined) {
    updates.totalTokens = tokensAfterCompaction;
    updates.totalTokensFresh = true;
    // Clear input/output breakdown since we only have the total estimate after compaction
    updates.inputTokens = undefined;
    updates.outputTokens = undefined;
    updates.cacheRead = undefined;
    updates.cacheWrite = undefined;
  }
  sessionStore[sessionKey] = {
    ...entry,
    ...updates,
  };
  const agentId =
    resolveAgentIdFromSessionKey(sessionKey) ??
    (cfg ? resolveSessionAgentId({ sessionKey, config: cfg }) : undefined);
  if (agentId) {
    upsertSessionEntry({
      agentId,
      sessionKey,
      entry: mergeSessionEntry(getSessionEntry({ agentId, sessionKey }), {
        ...updates,
      }),
    });
  }
  if (sessionIdChanged && cfg) {
    emitCompactionSessionLifecycleHooks({
      cfg,
      sessionKey,
      previousEntry: entry,
      nextEntry: sessionStore[sessionKey],
    });
  }
  return nextCount;
}
