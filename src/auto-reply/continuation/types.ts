import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "../reply/queue/types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OverseerStructuredUpdate } from "../../infra/overseer/store.types.js";

// ─── Completion Events (Discriminated Union) ────────────────────────────────

export type CompletionLevel = "turn" | "run" | "queue";

export type TurnCompletionEvent = {
  level: "turn";
  runId: string;
  sessionId: string;
  sessionKey?: string;
  timestamp: number;
  assistantTexts: string[];
  toolMetas: Array<{ toolName?: string; meta?: string }>;
  didSendViaMessagingTool: boolean;
  lastToolError?: { toolName: string; error?: string };
  /** Parsed overseerUpdate from agent response (if present) */
  structuredUpdate?: OverseerStructuredUpdate;
};

export type RunCompletionEvent = {
  level: "run";
  runId: string;
  sessionId: string;
  sessionKey: string;
  queueKey: string;
  timestamp: number;
  payloads: ReplyPayload[];
  autoCompactionCompleted: boolean;
  model: string;
  provider: string;
  followupRun?: FollowupRun;
  sessionEntry?: SessionEntry;
};

export type QueueCompletionEvent = {
  level: "queue";
  sessionKey?: string;
  queueKey: string;
  timestamp: number;
  queueEmpty: boolean;
  itemsProcessed: number;
  lastRun?: FollowupRun["run"];
};

export type CompletionEvent = TurnCompletionEvent | RunCompletionEvent | QueueCompletionEvent;

// ─── Continuation Decision ──────────────────────────────────────────────────

export type ContinuationAction = "none" | "enqueue" | "immediate";

export type ContinuationDecision = {
  action: ContinuationAction;
  nextPrompt?: string;
  delayMs?: number;
  reason?: string;
  goalUpdate?: Partial<GoalState>;
};

// ─── Goal State (persisted in SessionEntry) ─────────────────────────────────

export type GoalState = {
  /** Unique ID for this session-level goal tracking */
  id: string;
  /** Human-readable description (may be derived from Overseer goal title) */
  description: string;
  /** Current status */
  status: "active" | "paused" | "completed" | "failed";
  /** Progress percentage (0-100) */
  progress: number;
  /** Number of turns used for this goal in this session */
  turnsUsed: number;
  /** Maximum turns allowed before pausing */
  maxTurns?: number;
  /** Milestone checkpoints */
  checkpoints?: Array<{ id: string; description: string; completed: boolean }>;
  /** Timestamps */
  createdAt: number;
  updatedAt: number;

  // ─── Overseer Integration ───────────────────────────────────────────────────

  /** Link to Overseer goal (if managed by Overseer) */
  overseerGoalId?: string;
  /** Link to Overseer assignment (if this session is an assignment) */
  overseerAssignmentId?: string;
  /** Link to Overseer work node being executed */
  overseerWorkNodeId?: string;
};

// ─── Handler Types ──────────────────────────────────────────────────────────

export type CompletionHandler = (
  event: CompletionEvent,
) => ContinuationDecision | Promise<ContinuationDecision> | void | Promise<void>;

export type CompletionHandlerRegistration = {
  id: string;
  handler: CompletionHandler;
  priority?: number; // lower = runs first, default 100
  levels?: CompletionLevel[]; // filter to specific levels
};
