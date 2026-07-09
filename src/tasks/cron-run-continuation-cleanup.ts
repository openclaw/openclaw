/** Removes an idle exact-run continuation through the session lifecycle owner. */
import { getRuntimeConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import { hasPendingGeneratedMediaTaskForSessionKey } from "./task-status-access.js";

export async function removeCronRunContinuationSessionIfIdle(sessionKey: string): Promise<void> {
  if (
    !parseCronRunScopeSuffix(sessionKey).runId ||
    hasPendingGeneratedMediaTaskForSessionKey(sessionKey)
  ) {
    return;
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const cfg = getRuntimeConfig();
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const entry = loadSessionEntry({
    agentId,
    sessionKey,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  });
  const marker = entry?.cronRunContinuation;
  if (!entry || marker?.phase !== "ready" || marker.ownerRunId || marker.basePersisted !== true) {
    return;
  }
  await deleteSessionEntryLifecycle({
    agentId,
    // Exact rows alias the stable cron transcript; the stable row owns archival.
    archiveTranscript: false,
    expectedEntry: entry,
    expectedLifecycleRevision: entry.lifecycleRevision,
    expectedSessionId: entry.sessionId,
    expectedUpdatedAt: entry.updatedAt,
    requireWriteSuccess: true,
    storePath,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
  });
}
