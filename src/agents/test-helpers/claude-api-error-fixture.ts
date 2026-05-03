const CLAUDE_API_ERROR_MESSAGE =
  "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.";

/**
 * Stream-json output observed when `claude --resume <uuid>` is invoked with
 * a session ID that no longer exists on disk (or never did). The runtime
 * error string lands in the top-level `errors: string[]` array on the final
 * `result` message — not in `result`/`message`/`error` fields.
 *
 * Captured from claude-cli 2.1.119 in production after dashboard chat
 * bricked at 30-min heartbeat cadence with the same stale binding.
 */
export function createClaudeNoConversationFoundFixture() {
  const sessionId = "390db08a-5288-4622-9ee6-6594428f60b7";
  const resultSessionId = "059d8e2d-3983-4a21-8f5d-bb11e0ebde4d";
  const message = `No conversation found with session ID: ${sessionId}`;
  return {
    sessionId,
    message,
    jsonl: [
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: true,
        num_turns: 0,
        stop_reason: null,
        session_id: resultSessionId,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: "49107c9e-3cb9-4476-9ff8-b4e05a6cf6c2",
        errors: [message],
      }),
    ].join("\n"),
  };
}

export function createClaudeApiErrorFixture() {
  const apiError = `API Error: 400 ${JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: CLAUDE_API_ERROR_MESSAGE,
    },
    request_id: "req_011CZqHuXhFetYCnr8325DQc",
  })}`;

  return {
    message: CLAUDE_API_ERROR_MESSAGE,
    apiError,
    jsonl: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-api-error" }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: apiError }],
        },
        session_id: "session-api-error",
        error: "unknown",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: apiError,
        session_id: "session-api-error",
      }),
    ].join("\n"),
  };
}
