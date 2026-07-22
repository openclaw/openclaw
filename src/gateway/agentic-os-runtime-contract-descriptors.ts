/** Public RPC surface for the Agentic OS runtime contract. */
export const AGENTIC_OS_RUNTIME_METHOD_DESCRIPTORS = [
  {
    name: "subagents.allowLease.acquire",
    parameters: [
      "client_lease_id",
      "idempotency_key",
      "run_id",
      "phase",
      "transition_id",
      "agent_id",
      "requester_agent_id",
      "ttl_ms",
    ],
  },
  { name: "subagents.allowLease.status", parameters: [] },
  {
    name: "subagents.allowLease.release",
    parameters: [
      "client_lease_id",
      "release_idempotency_key",
      "run_id",
      "phase",
      "transition_id",
      "agent_id",
      "requester_agent_id",
      "gateway_lease_id",
    ],
  },
  {
    name: "sessions_spawn",
    parameters: [
      "task",
      "taskName",
      "runtime",
      "mode",
      "agentId",
      "client_request_id",
      "idempotency_key",
      "gateway_lease_id",
      "metadata",
    ],
  },
  { name: "sessions_list", parameters: [] },
  { name: "sessions_status", parameters: ["session_key"] },
  { name: "sessions_history", parameters: ["sessionKey", "limit", "includeTools"] },
] as const;
