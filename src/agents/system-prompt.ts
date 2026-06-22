function buildHeartbeatSection(params: { isMinimal: boolean; heartbeatPrompt?: string }) {
  if (params.isMinimal || !params.heartbeatPrompt) {
    return [];
  }
  return [
    "## Heartbeats",
    "You are currently in a HEARTBEAT session. You MUST NOT hallucinate work or invent user requests.",
    "If the current user message is a heartbeat poll and nothing needs attention, reply exactly:",
    "HEARTBEAT_OK",
    "DO NOT use write, exec, or edit tools during heartbeats unless it is to address a specific, verified issue discovered during the poll.",
    'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
    "",
  ];
}