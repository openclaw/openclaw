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

/**
 * Names the agent a job's own session reference belongs to: the `session:<key>` target the run
 * resolves first, then the legacy scoped `sessionKey`. Malformed targets name no owner.
 */
export function resolveCronJobSessionRefAgentId(job: {
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): string | undefined {
  let targetKey: string | undefined;
  try {
    targetKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
  } catch {
    targetKey = undefined;
  }
  return (
    (targetKey ? parseAgentSessionKey(targetKey)?.agentId : undefined) ??
    parseAgentSessionKey(job.sessionKey)?.agentId
  );
}

/** Resolves cron ownership: explicit non-blank id, scoped session key, then configured default. */
export function tryResolveCronJobEffectiveAgentId(
  job: CronAgentScope,
  configuredDefaultAgentId?: string,
): string | undefined {
  const agentId =
    job.agentId?.trim() ||
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
