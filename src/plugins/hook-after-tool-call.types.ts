export type PluginHookAfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
  /**
   * The harness refused the call: the named tool was not offered to this run, so
   * nothing was dispatched and `result` carries the harness's own refusal text
   * instead of tool output. The host sets this from the run's offered-tool
   * registry alone, and omits it whenever that set is not known to be complete,
   * so an absent field means "unknown", never "the call ran".
   */
  rejected?: boolean;
};
