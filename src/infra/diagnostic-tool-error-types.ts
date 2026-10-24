export type DiagnosticToolTerminalReason = "failed" | "cancelled" | "timed_out";

export type DiagnosticToolExecutionErrorFields = {
  type: "tool.execution.error";
  durationMs: number;
  errorCategory: string;
  errorCode?: string;
  terminalReason?: DiagnosticToolTerminalReason;
  /** Exit code of a failed command-execution tool, when the runtime reports one. */
  exitCode?: number;
};
