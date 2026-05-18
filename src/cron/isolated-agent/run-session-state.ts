import fs from "node:fs";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { SessionEntry } from "../../config/sessions.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { resolveCronSession } from "./session.js";

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

export function applyCronDeliveryRouteToSessionEntry(params: {
  entry: MutableCronSessionEntry;
  resolvedDelivery:
    | {
        ok: true;
        channel: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
      }
    | { ok: false };
}) {
  if (!params.resolvedDelivery.ok) {
    return;
  }
  const channel = normalizeOptionalString(params.resolvedDelivery.channel);
  const to = normalizeOptionalString(params.resolvedDelivery.to);
  if (!channel || !to) {
    return;
  }
  const accountId = normalizeOptionalString(params.resolvedDelivery.accountId);
  const threadId =
    params.resolvedDelivery.threadId === undefined || params.resolvedDelivery.threadId === null
      ? undefined
      : normalizeOptionalString(String(params.resolvedDelivery.threadId));

  params.entry.channel = channel;
  params.entry.lastChannel = channel;
  params.entry.lastTo = to;
  if (accountId) {
    params.entry.lastAccountId = accountId;
  } else {
    delete params.entry.lastAccountId;
  }
  if (threadId) {
    params.entry.lastThreadId = threadId;
  } else {
    delete params.entry.lastThreadId;
  }
  params.entry.deliveryContext = {
    channel,
    to,
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function cronTranscriptExists(entry: SessionEntry): boolean {
  const sessionFile = entry.sessionFile?.trim();
  return Boolean(sessionFile && fs.existsSync(sessionFile));
}

function toNonResumableCronSessionEntry(entry: SessionEntry): SessionEntry {
  const next = { ...entry } as Partial<SessionEntry>;
  delete next.sessionId;
  delete next.sessionFile;
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
  updateSessionStore: UpdateSessionStore;
}): PersistCronSessionEntry {
  return async () => {
    if (params.isFastTestEnv) {
      return;
    }
    const persistedEntry =
      isCronSessionKey(params.agentSessionKey) &&
      params.cronSession.sessionEntry.sessionId &&
      !cronTranscriptExists(params.cronSession.sessionEntry)
        ? toNonResumableCronSessionEntry(params.cronSession.sessionEntry)
        : params.cronSession.sessionEntry;
    params.cronSession.store[params.agentSessionKey] = persistedEntry;
    await params.updateSessionStore(params.cronSession.storePath, (store) => {
      store[params.agentSessionKey] = persistedEntry;
    });
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
