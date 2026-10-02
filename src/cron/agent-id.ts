import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { CronAgentScope } from "./types-shared.js";

export const CRON_AGENT_SELECTION_REQUIRED_MESSAGE =
  "Agent-less cron job has no resolvable owner. Pass --agent <id> when creating or editing the job, or set agents.defaults.systemAgent.agentId.";
export const CRON_LEGACY_OWNER_REPAIR_REQUIRED_MESSAGE =
  'Legacy cron ownership needs repair. Run "openclaw doctor --fix" before running, editing, or removing this job.';

/** Resolves cron ownership: explicit non-blank id, scoped session key, then configured default. */
export function tryResolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
  legacyDefaultAgentId?: string,
): string | undefined {
  const agentId =
    job.agentId?.trim() ||
    parseAgentSessionKey(job.sessionKey)?.agentId ||
    (!legacyDefaultAgentId ? configuredDefaultAgentId?.trim() : undefined);
  return agentId ? normalizeAgentId(agentId) : undefined;
}

/** Requires an owner before cron execution or an owner-scoped mutation. */
export function resolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
  legacyDefaultAgentId?: string,
): string {
  const agentId = tryResolveCronJobEffectiveAgentId(
    job,
    configuredDefaultAgentId,
    legacyDefaultAgentId,
  );
  if (!agentId) {
    throw new Error(
      legacyDefaultAgentId
        ? CRON_LEGACY_OWNER_REPAIR_REQUIRED_MESSAGE
        : CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
    );
  }
  return agentId;
}
