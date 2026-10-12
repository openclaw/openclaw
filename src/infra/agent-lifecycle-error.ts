const AGENT_RUN_STALE_LIFECYCLE_ERROR = "Agent run belongs to a stale gateway lifecycle";
const AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE = "ERR_STALE_GATEWAY_LIFECYCLE";
const RESTART_RECOVERY_CLAIM_CHANGED_ERROR = "restart recovery claim changed before agent adoption";
const RESTART_RECOVERY_CLAIM_CHANGED_ERROR_CODE = "ERR_RESTART_RECOVERY_CLAIM_CHANGED";

export function createAgentRunStaleLifecycleError(): Error {
  return Object.assign(new Error(AGENT_RUN_STALE_LIFECYCLE_ERROR), {
    name: "AbortError",
    code: AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE,
  });
}

function hasLifecycleErrorCode(value: unknown, code: string): boolean {
  try {
    return value instanceof Error && "code" in value && value.code === code;
  } catch {
    return false;
  }
}

export function isAgentRunStaleLifecycleError(value: unknown): boolean {
  return hasLifecycleErrorCode(value, AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE);
}

export function createRestartRecoveryClaimChangedError(): Error {
  return Object.assign(new Error(RESTART_RECOVERY_CLAIM_CHANGED_ERROR), {
    name: "AbortError",
    code: RESTART_RECOVERY_CLAIM_CHANGED_ERROR_CODE,
  });
}

export function isRestartRecoveryClaimChangedError(value: unknown): boolean {
  return hasLifecycleErrorCode(value, RESTART_RECOVERY_CLAIM_CHANGED_ERROR_CODE);
}
