import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import type { CronAgentScope } from "./types-shared.js";

export const CRON_AGENT_SELECTION_REQUIRED_MESSAGE =
  "Agent-less cron job has no resolvable owner. Pass --agent <id> when creating or editing the job, or set agents.defaults.systemAgent.agentId.";

export class CronAgentSelectionRequiredError extends Error {
  readonly code = "AGENT_SELECTION_REQUIRED";

  constructor() {
    super(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
    this.name = "CronAgentSelectionRequiredError";
  }
}

/** Resolves the agent a `session:<sessionKey>` target runs in, when it names one. */
export function resolveCronSessionTargetAgentId(sessionTarget?: string | null): string | undefined {
  const sessionKey = resolveCronSessionTargetSessionKey(sessionTarget);
  const agentId = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
  return agentId ? normalizeAgentId(agentId) : undefined;
}

/**
 * Resolves cron ownership: explicit non-blank id, the agent named by the job's own
 * session target, its scoped session key, then the configured default.
 */
export function tryResolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
): string | undefined {
  const agentId =
    job.agentId?.trim() ||
    resolveCronSessionTargetAgentId(job.sessionTarget) ||
    parseAgentSessionKey(job.sessionKey)?.agentId ||
    configuredDefaultAgentId?.trim();
  return agentId ? normalizeAgentId(agentId) : undefined;
}

/** Requires an owner before cron execution or an owner-scoped mutation. */
export function resolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
): string {
  const agentId = tryResolveCronJobEffectiveAgentId(job, configuredDefaultAgentId);
  if (!agentId) {
    throw new CronAgentSelectionRequiredError();
  }
  return agentId;
}
