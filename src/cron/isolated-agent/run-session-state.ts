import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { SessionEntry } from "../../config/sessions.js";
import { hasSqliteSessionTranscriptEvents } from "../../config/sessions/transcript-store.sqlite.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import type { resolveCronSession } from "./session.js";

type MutableSessionStore = Record<string, SessionEntry>;

export type MutableCronSessionEntry = SessionEntry;
export type MutableCronSession = ReturnType<typeof resolveCronSession> & {
  store: MutableSessionStore;
  sessionEntry: MutableCronSessionEntry;
};
export type CronLiveSelection = LiveSessionModelSelection;

type PersistSessionRow = (sessionKey: string, entry: SessionEntry) => Promise<void>;

export type PersistCronSessionEntry = () => Promise<void>;

function cronTranscriptExists(params: { sessionKey: string; entry: SessionEntry }): boolean {
  const sessionId = params.entry.sessionId?.trim();
  if (!sessionId) {
    return false;
  }
  return hasSqliteSessionTranscriptEvents({
    agentId: resolveAgentIdFromSessionKey(params.sessionKey),
    sessionId,
  });
}

function toNonResumableCronSessionEntry(entry: SessionEntry): SessionEntry {
  const next = { ...entry } as Partial<SessionEntry> & {
    sessionFile?: unknown;
    transcriptLocator?: unknown;
  };
  delete next.sessionId;
  delete next.sessionFile;
  delete next.transcriptLocator;
  delete next.sessionStartedAt;
  delete next.lastInteractionAt;
  delete next.cliSessionIds;
  delete next.cliSessionBindings;
  delete next.claudeCliSessionId;
  return next as SessionEntry;
}

export function createPersistCronSessionEntry(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  agentSessionKey: string;
  persistSessionRow: PersistSessionRow;
}): PersistCronSessionEntry {
  return async () => {
    if (params.isFastTestEnv) {
      return;
    }
    const persistedEntry =
      isCronSessionKey(params.agentSessionKey) &&
      params.cronSession.sessionEntry.sessionId &&
      !cronTranscriptExists({
        sessionKey: params.agentSessionKey,
        entry: params.cronSession.sessionEntry,
      })
        ? toNonResumableCronSessionEntry(params.cronSession.sessionEntry)
        : params.cronSession.sessionEntry;
    params.cronSession.store[params.agentSessionKey] = persistedEntry;
    await params.persistSessionRow(params.agentSessionKey, persistedEntry);
  };
}

export async function persistCronSkillsSnapshotIfChanged(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  skillsSnapshot: SkillSnapshot;
  nowMs: number;
  persistSessionEntry: PersistCronSessionEntry;
}) {
  if (
    params.isFastTestEnv ||
    params.skillsSnapshot === params.cronSession.sessionEntry.skillsSnapshot
  ) {
    return;
  }
  params.cronSession.sessionEntry = {
    ...params.cronSession.sessionEntry,
    updatedAt: params.nowMs,
    skillsSnapshot: params.skillsSnapshot,
  };
  await params.persistSessionEntry();
}

export function markCronSessionPreRun(params: {
  entry: MutableCronSessionEntry;
  provider: string;
  model: string;
}) {
  params.entry.modelProvider = params.provider;
  params.entry.model = params.model;
  params.entry.systemSent = true;
}

export function syncCronSessionLiveSelection(params: {
  entry: MutableCronSessionEntry;
  liveSelection: CronLiveSelection;
}) {
  params.entry.modelProvider = params.liveSelection.provider;
  params.entry.model = params.liveSelection.model;
  if (params.liveSelection.authProfileId) {
    params.entry.authProfileOverride = params.liveSelection.authProfileId;
    params.entry.authProfileOverrideSource = params.liveSelection.authProfileIdSource;
    if (params.liveSelection.authProfileIdSource === "auto") {
      params.entry.authProfileOverrideCompactionCount = params.entry.compactionCount ?? 0;
    } else {
      delete params.entry.authProfileOverrideCompactionCount;
    }
    return;
  }
  delete params.entry.authProfileOverride;
  delete params.entry.authProfileOverrideSource;
  delete params.entry.authProfileOverrideCompactionCount;
}
