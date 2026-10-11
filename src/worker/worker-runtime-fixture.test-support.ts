import type { ExecApprovalsFile } from "../infra/exec-approvals.js";

type InferencePlan =
  | "text"
  | "read-image"
  | "tool"
  | "safe-tool"
  | "background-tool"
  | "process-poll"
  | "process-kill"
  | "session-tool"
  | "computer"
  | "hold"
  | "fence"
  | "error"
  | "cancelled"
  | "length"
  | "burst-text"
  | "oversized-text"
  | "oversized-error"
  | "empty-terminal"
  | { args: Record<string, unknown>; toolCallId: string; toolName: string };

export type FakeGatewayOptions = {
  admissionFailure?: "gateway-unavailable" | "invalid-credential" | "owner-epoch-mismatch";
  backgroundCommand?: string;
  execCommand?: string;
  onApprovalWait?: () => void;
  approvalDecision?: "allow-once" | "deny" | null | "hold";
  execApprovals?: ExecApprovalsFile;
  inferencePlans?: InferencePlan[];
  outageOnInferenceCancel?: boolean;
  ignoreFirstAdmission?: boolean;
  ignoreHeartbeat?: boolean;
  silenceFirstTranscript?: boolean;
  silenceFirstLiveEvent?: boolean;
  silenceFirstInference?: boolean;
  dropSessionToolResponses?: number;
  transcriptFailureAtRequest?: number;
  liveResyncAckedSeq?: number;
  liveResyncResponses?: number;
  liveFailure?: "capacity-exceeded";
  heartbeatFailure?: "credential-expired";
  heartbeatIntervalMs?: number;
  computerSnapshot?: string;
  computerCleanupFailure?: boolean;
  onComputerClose?: () => void;
};
