export type ChatRunPhase =
  | "sent"
  | "received"
  | "thinking"
  | "using_tool"
  | "replying"
  | "complete"
  | "error"
  | "aborted";

export type ChatRunStatus = {
  phase: ChatRunPhase;
  runId?: string | null;
  label?: string;
  detail?: string;
  updatedAt: number;
};

export function chatRunStatusLabel(
  status: ChatRunStatus | null | undefined,
  assistantName: string | null | undefined,
): string | null {
  if (!status) {
    return null;
  }
  const name = assistantName?.trim() || "OpenClaw";
  if (status.label?.trim()) {
    return status.label.trim();
  }
  switch (status.phase) {
    case "sent":
      return "✓ Sent";
    case "received":
      return `✓ ${name} received this`;
    case "thinking":
      return `${name} is thinking…`;
    case "using_tool":
      return status.detail?.trim() ? `${name} is ${status.detail.trim()}…` : `${name} is working…`;
    case "replying":
      return `${name} is replying…`;
    case "complete":
      return "Complete";
    case "error":
      return status.detail?.trim() ? `Error: ${status.detail.trim()}` : "Error";
    case "aborted":
      return "Stopped";
    default:
      return null;
  }
}
