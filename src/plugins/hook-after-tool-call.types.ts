export type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
  /**
   * Host classifier verdict (`completed`, `error`, `blocked`), mirroring the
   * canonical `tool.execution.*` diagnostic for this call. Absent when the
   * host has no structured outcome; absence never means success.
   */
  outcome?: "completed" | "error" | "blocked";
};
