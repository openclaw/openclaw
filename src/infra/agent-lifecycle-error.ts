const AGENT_RUN_STALE_LIFECYCLE_ERROR = "Agent run belongs to a stale gateway lifecycle";
const AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE = "ERR_STALE_GATEWAY_LIFECYCLE";

export function createAgentRunStaleLifecycleError(): Error {
  return Object.assign(new Error(AGENT_RUN_STALE_LIFECYCLE_ERROR), {
    name: "AbortError",
    code: AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE,
  });
}

export function isAgentRunStaleLifecycleError(value: unknown): boolean {
  try {
    return (
      value instanceof Error &&
      "code" in value &&
      value.code === AGENT_RUN_STALE_LIFECYCLE_ERROR_CODE
    );
  } catch {
    return false;
  }
}
