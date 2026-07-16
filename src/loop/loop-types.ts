/**
 * Enhanced type definitions for the multi-phase /loop system.
 *
 * These types describe the loop phases, subtasks, and the structured data
 * exchanged between the TUI controller and the agent during a /loop session.
 */

export type LoopPhase =
  | "idle"
  | "analyze"
  | "plan"
  | "execute"
  | "verify"
  | "report"
  | "complete";

export const LOOP_PHASE_LABELS: Record<LoopPhase, string> = {
  idle: "Idle",
  analyze: "Analysis",
  plan: "Planning",
  execute: "Execution",
  verify: "Verification",
  report: "Report",
  complete: "Complete",
};

export const LOOP_PHASE_ORDER: LoopPhase[] = [
  "analyze",
  "plan",
  "execute",
  "verify",
  "report",
];

/** Phase transition rules: which phase can follow which */
export const LOOP_PHASE_TRANSITIONS: Record<LoopPhase, LoopPhase[]> = {
  idle: ["analyze"],
  analyze: ["plan"],
  plan: ["execute"],
  execute: ["verify"],
  verify: ["report"],
  report: ["complete"],
  complete: [],
};

/** Maximum retries for a subtask before marking as failed */
export const MAX_SUBTASK_RETRIES = 3;

export type LoopSubtaskStatus =
  | "pending"
  | "in-progress"
  | "complete"
  | "failed"
  | "skipped";

export type LoopSubtask = {
  id: string;
  name: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  parallelizable: boolean;
  priority?: "low" | "normal" | "high" | "critical";
  estimatedDuration?: number; // seconds
  actualDuration?: number; // seconds
  retryCount?: number;
  status: LoopSubtaskStatus;
  worktreePath?: string;
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  verdict?: {
    passed: boolean;
    notes: string;
    confidence?: number; // 0-1
  };
};

/** Data returned by the agent when completing a phase via loop_update. */
export type PhaseCompletePayload = {
  phase: LoopPhase;
  summary: string;
  subtasks?: LoopSubtask[];
  subtaskId?: string;
  passed?: boolean;
  details?: Record<string, unknown>;
  warnings?: string[];
  metrics?: {
    duration?: number; // seconds
    tokenUsage?: number;
    memoryPeak?: number; // MB
  };
};

/** Subtask update payload sent via loop_update. */
export type SubtaskUpdatePayload = {
  subtaskId: string;
  status: LoopSubtaskStatus;
  result?: string;
  error?: string;
  worktreePath?: string;
  priority?: string;
};

/** Loop state for persistence and diagnostics */
export type LoopStateMetadata = {
  task: string;
  createdAt: string;
  updatedAt: string;
  version: string;
  totalIterations: number;
  completedPhases: LoopPhase[];
  errorHistory?: Array<{
    phase?: LoopPhase;
    subtaskId?: string;
    error: string;
    timestamp: string;
  }>;
  summary?: string;
};

/** Diagnostic info for debugging */
export type LoopDiagnostics = {
  state: LoopStateMetadata;
  activeSubtasks: number;
  pendingSubtasks: number;
  failedSubtasks: number;
  skippedSubtasks: number;
  nextPhase?: LoopPhase;
  isBlocked: boolean;
  blockReason?: string;
  cycleTime?: number; // seconds since start
};
