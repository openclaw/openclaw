/**
 * Team Types Definition
 * Core types for agent team coordination and task management
 * Based on OpenClaw Agent Teams Design (2026-02-23)
 */

/**
 * Team configuration structure
 * Defines how a team is initialized and configured
 */
export interface TeamConfig {
  /** Unique identifier for the team (UUID) */
  id: string;
  /** Path-safe team identifier (1-50 chars, alphanumeric/hyphen/underscore) */
  name: string;
  /** Human-readable description of the team's purpose */
  description?: string;
  /** Agent type for team lead */
  agentType?: string;
  /** Unix timestamp when team was created */
  createdAt: number;
  /** Unix timestamp when team was last updated */
  updatedAt: number;
  /** Team status */
  status: "active" | "shutdown";
  /** Session key of the team lead */
  leadSessionKey: string;
}

/**
 * Team member structure
 * Represents an agent participating in a team
 */
export interface TeamMember {
  /** Primary key: session key of the agent */
  sessionKey: string;
  /** Agent type ID */
  agentId: string;
  /** Display name for the agent */
  name?: string;
  /** Role in the team */
  role: "lead" | "member";
  /** Unix timestamp when member joined the team */
  joinedAt: number;
  /** Unix timestamp of last activity */
  lastActiveAt?: number;
}

/**
 * Task structure
 * Represents a unit of work in a team's task ledger
 */
export interface Task {
  /** Unique identifier (UUID) */
  id: string;
  /** Brief title in imperative form (max 200 chars) */
  subject: string;
  /** Detailed description (max 10000 chars) */
  description: string;
  /** Present continuous form shown during work (max 100 chars) */
  activeForm?: string;
  /** Current status */
  status: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "deleted";
  /** Session key of the claiming agent (empty if unassigned) */
  owner?: string;
  /** Array of task IDs that must complete before this task can start */
  dependsOn?: string[];
  /** Computed array of task IDs blocking this task */
  blockedBy?: string[];
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Unix timestamp when task was created */
  createdAt: number;
  /** Unix timestamp when task was claimed */
  claimedAt?: number;
  /** Unix timestamp when task was completed */
  completedAt?: number;
}

/**
 * Team message structure
 * Represents communication between team members
 */
export interface TeamMessage {
  /** Unique identifier (UUID) */
  id: string;
  /** Session key of the sender */
  from: string;
  /** Session key of the recipient (optional for broadcast) */
  to?: string;
  /** Message type */
  type:
    | "message"
    | "broadcast"
    | "shutdown_request"
    | "shutdown_response"
    | "idle"
    | "plan_approval_response";
  /** Message content (max 100KB) */
  content: string;
  /** Brief summary shown in UI (5-10 words) */
  summary?: string;
  /** Request ID for shutdown protocol */
  requestId?: string;
  /** Approval flag for shutdown_response */
  approve?: boolean;
  /** Rejection reason for shutdown_response */
  reason?: string;
  /** Unix timestamp when message was sent */
  timestamp: number;
}

/**
 * Team state structure
 * Aggregated team state for injection into context
 */
export interface TeamState {
  /** Team ID */
  id: string;
  /** Team name */
  name: string;
  /** Team description */
  description?: string;
  /** Team status */
  status: "active" | "shutdown";
  /** All team members */
  members: TeamMember[];
  /** Count of pending tasks */
  pendingTaskCount: number;
  /** Count of in-progress tasks */
  inProgressTaskCount: number;
  /** Count of completed tasks */
  completedTaskCount: number;
}

/**
 * Task claim operation result
 * Represents the outcome of attempting to claim a task
 */
export interface TaskClaimResult {
  /** Whether the claim was successful */
  success: boolean;
  /** ID of the task */
  taskId: string;
  /** Error message if claim failed */
  error?: string;
}

/**
 * Parameters for creating a task
 */
export interface CreateTaskParams {
  /** Task subject (max 200 chars) */
  subject: string;
  /** Task description (max 10000 chars) */
  description: string;
  /** Active form for display (max 100 chars) */
  activeForm?: string;
  /** Task metadata */
  metadata?: Record<string, unknown>;
  /** Array of task IDs this task depends on */
  dependsOn?: string[];
}

/**
 * Options for listing tasks
 */
export interface TaskListOptions {
  /** Filter by status */
  status?: "pending" | "claimed" | "in_progress" | "completed" | "failed" | "deleted";
  /** Filter by owner session key */
  owner?: string;
  /** Include completed tasks in results */
  includeCompleted?: boolean;
}
