/** Resolves and validates session-target keys used by cron jobs and delivery. */
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";

const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";

/** Returns whether an error came from cron session target id validation. */
export function isInvalidCronSessionTargetIdError(error: unknown): boolean {
  return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR;
}

/** Validates the opaque session id portion of a `session:` cron target. */
export function assertSafeCronSessionTargetId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  if (trimmed.includes("\0")) {
    throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
  }
  return trimmed;
}

/** Extracts the persistent session key from a `session:` cron target, if present. */
export function resolveCronSessionTargetSessionKey(
  sessionTarget?: string | null,
): string | undefined {
  if (typeof sessionTarget !== "string" || !sessionTarget.startsWith("session:")) {
    return undefined;
  }
  return assertSafeCronSessionTargetId(sessionTarget.slice(8));
}

/** Resolves a `session:` suffix against known persisted session ids when possible. */
export function resolveCronSessionTargetReferenceKey(params: {
  reference: string;
  entries: Array<[string, SessionEntry]>;
}): string {
  const reference = assertSafeCronSessionTargetId(params.reference);
  const exactKeyMatch = params.entries.find(([sessionKey]) => sessionKey === reference);
  if (exactKeyMatch) {
    return exactKeyMatch[0];
  }

  const sessionIdMatches = params.entries.filter(([, entry]) => entry.sessionId === reference);
  const selection = resolveSessionIdMatchSelection(sessionIdMatches, reference);
  if (selection.kind === "selected") {
    return selection.sessionKey;
  }
  if (selection.kind === "ambiguous") {
    throw new Error(
      `ambiguous cron sessionTarget session id "${reference}" matches multiple sessions: ${selection.sessionKeys.join(", ")}`,
    );
  }
  return reference;
}

/** Resolves `session:<key-or-sessionId>` to the persisted session key used at runtime. */
export function resolveCronSessionTargetSessionKeyFromStore(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionTarget?: string | null;
}): string | undefined {
  const reference = resolveCronSessionTargetSessionKey(params.sessionTarget);
  if (!reference) {
    return undefined;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  return resolveCronSessionTargetReferenceKey({
    reference,
    entries: Object.entries(store),
  });
}

/** Resolves `current` at creation time so scheduled jobs do not depend on future active UI state. */
export function resolveCronCurrentSessionTarget(params: {
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): string | undefined {
  if (params.sessionTarget !== "current") {
    return params.sessionTarget ?? undefined;
  }
  const sessionKey = params.sessionKey?.trim();
  return sessionKey ? `session:${assertSafeCronSessionTargetId(sessionKey)}` : "isolated";
}

/** Chooses the session key used for cron delivery, preferring explicit persistent targets. */
export function resolveCronDeliverySessionKey(job: {
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): string | undefined {
  const sessionTargetKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  if (sessionTargetKey) {
    return sessionTargetKey;
  }
  return typeof job.sessionKey === "string" && job.sessionKey.trim()
    ? job.sessionKey.trim()
    : undefined;
}

/** Chooses the delivery session key after resolving stored session-id references. */
export function resolveCronDeliverySessionKeyFromStore(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  job: {
    sessionTarget?: string | null;
    sessionKey?: string | null;
  };
}): string | undefined {
  const sessionTargetKey = resolveCronSessionTargetSessionKeyFromStore({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionTarget: params.job.sessionTarget,
  });
  if (sessionTargetKey) {
    return sessionTargetKey;
  }
  return typeof params.job.sessionKey === "string" && params.job.sessionKey.trim()
    ? params.job.sessionKey.trim()
    : undefined;
}

/** Returns the notification session key, falling back to a stable per-job failure session. */
export function resolveCronNotificationSessionKey(params: {
  jobId: string;
  sessionKey?: string | null;
}): string {
  return typeof params.sessionKey === "string" && params.sessionKey.trim()
    ? params.sessionKey.trim()
    : `cron:${params.jobId}:failure`;
}
