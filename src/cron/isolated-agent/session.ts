import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset-policy.js";
import { archiveRemovedSessionTranscripts } from "../../config/sessions/store.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveCronSession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  nowMs: number;
  agentId: string;
  forceNew?: boolean;
}) {
  const sessionCfg = params.cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];

  // Check if we can reuse an existing session
  let sessionId: string;
  let isNewSession: boolean;
  let systemSent: boolean;

  if (!params.forceNew && entry?.sessionId) {
    // Evaluate freshness using the configured reset policy
    // Cron/webhook sessions use "direct" reset type (1:1 conversation style)
    const resetPolicy = resolveSessionResetPolicy({
      sessionCfg,
      resetType: "direct",
    });
    const freshness = evaluateSessionFreshness({
      updatedAt: entry.updatedAt,
      now: params.nowMs,
      policy: resetPolicy,
    });

    if (freshness.fresh) {
      // Reuse existing session
      sessionId = entry.sessionId;
      isNewSession = false;
      systemSent = entry.systemSent ?? false;
    } else {
      // Session expired, create new
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }
  } else {
    // No existing session or forced new
    sessionId = crypto.randomUUID();
    isNewSession = true;
    systemSent = false;
  }

  clearBootstrapSnapshotOnSessionRollover({
    sessionKey: params.sessionKey,
    previousSessionId: isNewSession ? entry?.sessionId : undefined,
  });

  const sessionEntry: SessionEntry = {
    // Preserve existing per-session overrides even when rolling to a new sessionId.
    ...entry,
    // Always update these core fields
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    // When starting a fresh session (forceNew / isolated), clear delivery routing
    // state inherited from prior sessions. Without this, lastThreadId leaks into
    // the new session and causes announce-mode cron deliveries to post as thread
    // replies instead of channel top-level messages.
    // deliveryContext must also be cleared because normalizeSessionEntryDelivery
    // repopulates lastThreadId from deliveryContext.threadId on store writes.
    ...(isNewSession && {
      lastChannel: undefined,
      lastTo: undefined,
      lastAccountId: undefined,
      lastThreadId: undefined,
      deliveryContext: undefined,
      sessionFile: undefined,
    }),
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession };
}

/**
 * Snapshot of a prior session entry's identity at the time a rotation is
 * about to happen, for feeding into `archivePriorIsolatedEntryAfterRotation`
 * once the rotation is persisted.
 */
export type PriorIsolatedEntryForArchival = {
  sessionId: string;
  sessionFile?: string;
};

/**
 * Snapshot the prior entry's sessionId + sessionFile so the transcript can be
 * archived after rotation. Call BEFORE writing the new entry — once the store
 * is overwritten, the prior identity is gone. Returns undefined when there's
 * no rotation (non-`isNewSession` or no prior entry), making archival a no-op.
 */
export function capturePriorIsolatedEntryForArchival(params: {
  store: Record<string, SessionEntry>;
  sessionKey: string;
  isNewSession: boolean;
}): PriorIsolatedEntryForArchival | undefined {
  if (!params.isNewSession) {
    return undefined;
  }
  const prior = params.store[params.sessionKey];
  if (!prior?.sessionId) {
    return undefined;
  }
  return { sessionId: prior.sessionId, sessionFile: prior.sessionFile };
}

/**
 * Rename the captured prior transcript to `<file>.reset.<ts>`. Call AFTER
 * the new entry is persisted: `archiveRemovedSessionTranscripts` skips any
 * sessionId still referenced in the store, so a post-update store ensures
 * the prior file is archived only when genuinely orphaned. No-op on
 * undefined. Uses `reason: "reset"` (retention via
 * `maintenance.resetArchiveRetentionMs`) rather than `"deleted"` because
 * the store entry persists — only the transcript is rolling. Errors are
 * not caught; callers wrap in try/catch with their own logger.
 */
export async function archivePriorIsolatedEntryAfterRotation(params: {
  priorEntryForArchival: PriorIsolatedEntryForArchival | undefined;
  store: Record<string, SessionEntry>;
  storePath: string;
}): Promise<void> {
  const prior = params.priorEntryForArchival;
  if (!prior) {
    return;
  }
  const referencedSessionIds = new Set(
    Object.values(params.store)
      .map((entry) => entry?.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
  await archiveRemovedSessionTranscripts({
    removedSessionFiles: new Map([[prior.sessionId, prior.sessionFile]]),
    referencedSessionIds,
    storePath: params.storePath,
    reason: "reset",
    restrictToStoreDir: true,
  });
}
