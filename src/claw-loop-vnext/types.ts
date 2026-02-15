export type PhaseStatus = "pending" | "in_progress" | "complete" | "blocked";

export type GoalPhase = {
  id: string;
  name: string;
  status: PhaseStatus;
  passes: boolean;
  description?: string;
  prompt?: string;
  notes?: string;
  verification?: string;
  artifacts?: string[];
  requiresApproval?: boolean;
};

export type GoalFile = {
  title: string;
  workdir: string;
  tool?: string;
  status: "pending" | "in_progress" | "complete" | "blocked";
  phases: GoalPhase[];
  infiniteLoop?: boolean;
  session?: string;
  awaitingApproval?: string;
  orchestration?: {
    mode?: "bridge" | "sdk-first";
    ackTimeoutMs?: number;
    maxRetries?: number;
  };
};

export type Signal =
  | { type: "phase_complete"; phaseId: string; raw: string; dedupeKey: string }
  | { type: "phase_blocked"; reason: string; raw: string; dedupeKey: string }
  | { type: "goal_complete"; raw: string; dedupeKey: string }
  | { type: "promise_done"; raw: string; dedupeKey: string };

export type RuntimeState = {
  goalId: string;
  lastDeliveryByIdempotencyKey: Record<
    string,
    { delivered: boolean; transport: string; at: string }
  >;
  seenSignalKeys: Record<string, string>;
  lastOutputDigest?: string;
  lastActivityAt?: string;
  lastNudgeAt?: string;
  updatedAt: string;
};

export type LoopEvent = {
  at: string;
  goalId: string;
  type:
    | "message_send_attempt"
    | "message_send_ack"
    | "message_send_failed"
    | "transport_fallback"
    | "signal_seen"
    | "signal_deduped"
    | "phase_advanced"
    | "goal_updated"
    | "stuck_nudge_sent"
    | "stuck_nudge_skipped";
  data?: Record<string, unknown>;
};
