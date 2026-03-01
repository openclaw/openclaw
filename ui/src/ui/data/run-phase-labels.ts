export const RUN_PHASE_LABELS: Record<string, string> = {
  "lifecycle.start": "planning",
  "lifecycle.end": "finalizing",
  "lifecycle.error": "finalizing",
  "assistant.delta": "drafting",
  "assistant.stream": "drafting",
  "reasoning.stream": "reasoning",
  "tool.start": "analyzing",
  "tool.update": "analyzing",
  "tool.result": "reviewing",
  "chat.delta": "drafting",
  "chat.final": "finalizing",
  "chat.aborted": "finalizing",
  "chat.error": "finalizing",
  "fallback.active": "analyzing",
};

export const RUN_PHASE_SUFFIX_LABELS: Record<string, string> = {
  retrying: "retrying",
  error: "error",
};
