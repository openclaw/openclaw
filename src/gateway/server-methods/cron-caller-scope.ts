import type { CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { GatewayClient } from "./types.js";

export type CronCallerScope = {
  kind: "agentTool";
  agentId: string;
};

export function readCronCallerScope(
  client: GatewayClient | null | undefined,
): CronCallerScope | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (!identity?.agentId) {
    return undefined;
  }
  return { kind: "agentTool", agentId: normalizeAgentId(identity.agentId) };
}

function resolveCronJobEffectiveAgentId(job: CronJob, defaultAgentId?: string): string {
  return normalizeAgentId(job.agentId ?? defaultAgentId ?? DEFAULT_AGENT_ID);
}

function parseAgentIdFromSessionRef(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return parseAgentSessionKey(trimmed)?.agentId;
}

function parseAgentIdFromCronSessionTarget(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith("session:")) {
    return undefined;
  }
  return parseAgentIdFromSessionRef(trimmed.slice("session:".length));
}

function cronJobSessionRefsMatchCaller(job: CronJob, callerScope: CronCallerScope): boolean {
  const sessionAgentId = parseAgentIdFromSessionRef(job.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId = parseAgentIdFromCronSessionTarget(job.sessionTarget);
  return !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === callerScope.agentId;
}

export function cronJobMatchesCallerScope(params: {
  job: CronJob;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  if (
    resolveCronJobEffectiveAgentId(params.job, params.defaultAgentId) !== params.callerScope.agentId
  ) {
    return false;
  }
  return cronJobSessionRefsMatchCaller(params.job, params.callerScope);
}

export function cronCreateMatchesCallerScope(params: {
  job: CronJobCreate;
  callerScope: CronCallerScope | undefined;
  defaultAgentId?: string;
}): boolean {
  if (!params.callerScope) {
    return true;
  }
  const effectiveAgentId = normalizeAgentId(
    params.job.agentId ?? params.defaultAgentId ?? DEFAULT_AGENT_ID,
  );
  if (effectiveAgentId !== params.callerScope.agentId) {
    return false;
  }
  const sessionAgentId = parseAgentIdFromSessionRef(params.job.sessionKey);
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== params.callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId = parseAgentIdFromCronSessionTarget(params.job.sessionTarget);
  return (
    !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === params.callerScope.agentId
  );
}

export function applyCronCreateCallerScopeDefault(
  job: CronJobCreate,
  callerScope: CronCallerScope | undefined,
): CronJobCreate {
  if (!callerScope || "agentId" in job) {
    return job;
  }
  return {
    ...job,
    agentId: callerScope.agentId,
  };
}

export function cronPatchSessionRefsMatchCaller(
  patch: CronJobPatch,
  callerScope: CronCallerScope | undefined,
): boolean {
  if (!callerScope) {
    return true;
  }
  const sessionAgentId =
    "sessionKey" in patch && typeof patch.sessionKey === "string"
      ? parseAgentIdFromSessionRef(patch.sessionKey)
      : undefined;
  if (sessionAgentId && normalizeAgentId(sessionAgentId) !== callerScope.agentId) {
    return false;
  }
  const sessionTargetAgentId =
    "sessionTarget" in patch && typeof patch.sessionTarget === "string"
      ? parseAgentIdFromCronSessionTarget(patch.sessionTarget)
      : undefined;
  return !sessionTargetAgentId || normalizeAgentId(sessionTargetAgentId) === callerScope.agentId;
}
