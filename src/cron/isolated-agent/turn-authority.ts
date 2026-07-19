import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createAuthorizationPrincipal } from "../../plugins/authorization-policy-context.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import {
  createTurnAuthoritySnapshot,
  isIssuedTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";

const CRON_SERVICE_ID = "cron";

type CronTurnAuthorityBinding = {
  jobId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
};

function resolveCronControllerKey(jobId: string): string | undefined {
  const normalizedJobId = normalizeOptionalString(jobId);
  return normalizedJobId ? `service:${CRON_SERVICE_ID}:${normalizedJobId}` : undefined;
}

/** Issues the scheduler-owned authority shared by every runtime attempt for one cron turn. */
export function createCronTurnAuthoritySnapshot(params: {
  jobId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  runId: string;
}): TurnAuthoritySnapshot {
  const controllerKey = resolveCronControllerKey(params.jobId);
  if (!controllerKey) {
    throw new Error("cron turn authority requires a job id");
  }
  return createTurnAuthoritySnapshot({
    principal: createAuthorizationPrincipal({ serviceId: CRON_SERVICE_ID }),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    conversationId: params.sessionKey,
    trigger: CRON_SERVICE_ID,
    // Stable per job, unlike isolated run/session ids. This prevents one cron
    // job from steering or joining another job's live turn.
    controllerKey,
  });
}

/** Accepts only the scheduler authority minted for this exact cron run. */
export function isCronTurnAuthoritySnapshotForRun(
  value: unknown,
  binding: CronTurnAuthorityBinding,
): value is TurnAuthoritySnapshot {
  if (!isIssuedTurnAuthoritySnapshot(value)) {
    return false;
  }
  const controllerKey = resolveCronControllerKey(binding.jobId);
  const authorization = value.authorization;
  return Boolean(
    controllerKey &&
    authorization.principal.kind === "service" &&
    authorization.principal.serviceId === CRON_SERVICE_ID &&
    value.controllerKey === controllerKey &&
    authorization.agentId === binding.agentId &&
    authorization.sessionKey === binding.sessionKey &&
    authorization.sessionId === binding.sessionId &&
    authorization.runId === binding.runId &&
    authorization.conversationId === binding.sessionKey &&
    authorization.parentConversationId === undefined &&
    authorization.threadId === undefined &&
    authorization.trigger === CRON_SERVICE_ID,
  );
}
