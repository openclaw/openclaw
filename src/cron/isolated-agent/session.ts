import crypto from "node:crypto";
import { clearBootstrapSnapshotOnSessionRollover } from "../../agents/bootstrap-cache.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  evaluateSessionFreshness,
  resolveSessionResetPolicy,
} from "../../config/sessions/reset.js";
import {
  archiveRemovedSessionTranscripts,
  loadSessionStore,
} from "../../config/sessions/store.js";
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
    // sessionFile must ALSO be cleared so the downstream transcript resolver
    // (resolveSessionFilePath) falls through to computing a fresh path from
    // the new sessionId instead of reusing the inherited path. Without this,
    // every forceNew / stale rotation silently appends to the same physical
    // file forever — defeating isolatedSession and poisoning each run with
    // the in-context history of all prior runs. The prior transcript file
    // is orphaned by this rotation and must be archived by the caller via
    // `capturePriorIsolatedEntryForArchival` +
    // `archivePriorIsolatedEntryAfterRotation` (see below).
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
 * Capture the identity of the prior session entry at `sessionKey` so its
 * transcript file can be archived after `resolveCronSession` rotates to a
 * fresh session.
 *
 * Must be called BEFORE the caller writes `cronSession.sessionEntry` back to
 * the store — at that point, `store[sessionKey]` still reflects the prior
 * entry (its sessionId + sessionFile), which is exactly what needs to be
 * archived once the overwrite happens.
 *
 * Returns `undefined` when no rotation is in progress (either `isNewSession`
 * is false, or the store had no prior entry at the key). In both cases the
 * caller has nothing to archive.
 *
 * Paired with `archivePriorIsolatedEntryAfterRotation` — this function is
 * intentionally pure/sync so it can run inline in any caller without adding
 * async dependencies at capture time.
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
 * Archive the transcript file captured by `capturePriorIsolatedEntryForArchival`,
 * renaming it to `<file>.reset.<ts>` via `archiveRemovedSessionTranscripts`.
 * Safe to call with `priorEntryForArchival === undefined` (no-op).
 *
 * Must be called AFTER the new session entry has been persisted to the
 * store, so that `referencedSessionIds` (computed inside
 * `archiveRemovedSessionTranscripts`) contains the NEW sessionId and not
 * the old one. `archiveRemovedSessionTranscripts` skips any sessionId that
 * is still referenced elsewhere in the store, so passing the post-update
 * store guarantees the prior file is only archived when no other entry
 * still points at its sessionId.
 *
 * Uses `reason: "reset"` because the session entry persists at the same
 * key; only the transcript file is being rolled. `"reset"` archives get
 * cleaned up by `cleanupArchivedSessionTranscripts` after
 * `maintenance.resetArchiveRetentionMs` has elapsed — a separate retention
 * class from `"deleted"` archives (which are for genuinely-removed entries
 * and honour `maintenance.pruneAfterMs`).
 *
 * Errors from the underlying archival path are NOT caught here — the caller
 * decides whether to log/swallow them, because logger dependencies differ
 * by call site.
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
