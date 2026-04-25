import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  archivePriorIsolatedEntryAfterRotation,
  capturePriorIsolatedEntryForArchival,
  type PriorIsolatedEntryForArchival,
  type resolveCronSession,
} from "./session.js";

type PersistCronSessionLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
};

type MutableSessionStore = Record<string, SessionEntry>;

export type MutableCronSessionEntry = SessionEntry;
export type MutableCronSession = ReturnType<typeof resolveCronSession> & {
  store: MutableSessionStore;
  sessionEntry: MutableCronSessionEntry;
};
export type CronLiveSelection = LiveSessionModelSelection;

type UpdateSessionStore = (
  storePath: string,
  update: (store: MutableSessionStore) => void,
) => Promise<void>;

export type PersistCronSessionEntry = () => Promise<void>;

export function createPersistCronSessionEntry(params: {
  isFastTestEnv: boolean;
  cronSession: MutableCronSession;
  agentSessionKey: string;
  runSessionKey: string;
  updateSessionStore: UpdateSessionStore;
  log?: PersistCronSessionLogger;
}): PersistCronSessionEntry {
  // Capture before persist. In the cron: prefix case (runSessionKey is
  // `...:run:<id>`), the session-reaper only archives the run-key entry's
  // file on retention — this is the only path that reaches the prior
  // agentSessionKey transcript.
  const priorEntryForArchival: PriorIsolatedEntryForArchival | undefined =
    capturePriorIsolatedEntryForArchival({
      store: params.cronSession.store,
      sessionKey: params.agentSessionKey,
      isNewSession: params.cronSession.isNewSession,
    });
  let archivedPrior = false;

  return async () => {
    if (params.isFastTestEnv) {
      return;
    }
    params.cronSession.store[params.agentSessionKey] = params.cronSession.sessionEntry;
    if (params.runSessionKey !== params.agentSessionKey) {
      params.cronSession.store[params.runSessionKey] = params.cronSession.sessionEntry;
    }
    await params.updateSessionStore(params.cronSession.storePath, (store) => {
      store[params.agentSessionKey] = params.cronSession.sessionEntry;
      if (params.runSessionKey !== params.agentSessionKey) {
        store[params.runSessionKey] = params.cronSession.sessionEntry;
      }
    });

    // Once-flag: persist is called multiple times per run (pre-run, skills
    // refresh, finalize); only the first call should attempt the archive.
    if (!archivedPrior) {
      archivedPrior = true;
      try {
        await archivePriorIsolatedEntryAfterRotation({
          priorEntryForArchival,
          store: params.cronSession.store,
          storePath: params.cronSession.storePath,
        });
      } catch (err) {
        params.log?.warn("cron: failed to archive rotated isolated session transcript", {
          err: String(err),
          agentSessionKey: params.agentSessionKey,
          priorSessionId: priorEntryForArchival?.sessionId,
        });
      }
    }
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
