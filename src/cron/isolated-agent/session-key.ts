/** Canonicalizes cron session keys into agent-scoped session-store keys. */
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { SessionScope } from "../../config/sessions/types.js";
import { isCronSessionKey, toAgentStoreSessionKey } from "../../routing/session-key.js";
import { isDetachedCronSessionTarget } from "../session-target.js";
import type { CronJob } from "../types.js";

/** Resolves a cron session key into the canonical agent-scoped session-store key. */
export function resolveCronAgentSessionKey(params: {
  sessionKey: string;
  agentId: string;
  mainKey?: string | undefined;
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
}): string {
  const raw = toAgentStoreSessionKey({
    agentId: params.agentId,
    requestKey: params.sessionKey.trim(),
    mainKey: params.mainKey,
  });
  // Canonicalize so "agent:<id>:main" → "agent:<id>:<configuredMainKey>"
  // when cfg.session.mainKey differs from "main". Without this, cron sessions
  // are orphaned when read paths use the configured mainKey alias (#29683).
  return canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: raw,
  });
}

/** Selects the execution identity and any creating conversation before session admission. */
export function resolveCronRunSessionKeys(params: {
  job: CronJob;
  sessionKey?: string;
  agentId: string;
  cfg: { session?: { scope?: SessionScope; mainKey?: string } };
}) {
  const { job, agentId, cfg } = params;
  const baseSessionKey = (params.sessionKey?.trim() || `cron:${job.id}`).trim();
  // A `current` job keeps its own run key; conversation resources come from admission.
  const currentBoundSourceKey =
    job.sessionTarget === "current" ? job.sessionKey?.trim() : undefined;
  const usesDetachedRunSession =
    isDetachedCronSessionTarget(job.sessionTarget) || Boolean(currentBoundSourceKey);
  const baseSessionKeyIsCron =
    baseSessionKey.startsWith("cron:") || isCronSessionKey(baseSessionKey);
  const agentSessionKey = resolveCronAgentSessionKey({
    sessionKey: usesDetachedRunSession && !baseSessionKeyIsCron ? `cron:${job.id}` : baseSessionKey,
    agentId,
    mainKey: cfg.session?.mainKey,
    cfg,
  });
  const resolvedBaseSessionKey = resolveCronAgentSessionKey({
    sessionKey: currentBoundSourceKey ?? baseSessionKey,
    agentId,
    mainKey: cfg.session?.mainKey,
    cfg,
  });
  const sourceSessionKey =
    currentBoundSourceKey && resolvedBaseSessionKey !== agentSessionKey
      ? resolvedBaseSessionKey
      : undefined;
  return { baseSessionKey, usesDetachedRunSession, agentSessionKey, sourceSessionKey };
}
