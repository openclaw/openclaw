/**
 * Team coordination layer — groups sub-agent sessions into named team runs
 * with shared task boards and inter-agent messaging.
 *
 * Modeled after Claude Code's team primitives (TeamCreate, TaskList, SendMessage).
 */

// ─── Team Run ────────────────────────────────────────────────────────

export type TeamRunState = "active" | "completed" | "failed";

export type TeamMember = {
  agentId: string;
  sessionKey: string;
  /** Optional role label (e.g. "researcher", "coder", "tester"). */
  role?: string;
  state: "idle" | "running" | "done";
  joinedAt: number;
};

export type TeamRun = {
  /** Unique team run ID (UUID). */
  id: string;
  /** Human-readable team name (e.g. "auth-refactor"). */
  name: string;
  /** Agent ID of the team leader (e.g. "neo"). */
  leader: string;
  /** Session key of the leader's session that initiated this team. */
  leaderSession: string;
  /** Team members (sub-agents spawned into this team). */
  members: TeamMember[];
  state: TeamRunState;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

// ─── Team Tasks ──────────────────────────────────────────────────────

export type TeamTaskStatus = "pending" | "in_progress" | "completed";

export type TeamTask = {
  /** Unique task ID within a team run (UUID). */
  id: string;
  /** Parent team run ID. */
  teamRunId: string;
  /** Brief imperative title (e.g. "Implement JWT middleware"). */
  subject: string;
  /** Detailed description with acceptance criteria. */
  description: string;
  /** Agent ID of the task owner (empty = unassigned). */
  owner?: string;
  status: TeamTaskStatus;
  /** Task IDs that must complete before this one can start. */
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
};

// ─── Team Messages ───────────────────────────────────────────────────

export type TeamMessage = {
  /** Unique message ID (UUID). */
  id: string;
  /** Parent team run ID. */
  teamRunId: string;
  /** Sender agent ID. */
  from: string;
  /** Recipient: agent ID for DM, "broadcast" for all members. */
  to: string;
  /** Message content (plain text). */
  content: string;
  timestamp: number;
  /** Read receipts: agentId -> epoch ms when the agent marked this message as read. */
  readBy?: Record<string, number>;
};

// ─── Store shape ─────────────────────────────────────────────────────

/** On-disk shape for the teams store file. */
export type TeamStoreData = {
  runs: Record<string, TeamRun>;
  tasks: Record<string, TeamTask[]>;
  messages: Record<string, TeamMessage[]>;
};
