/**
 * Team Manager Implementation
 * Core orchestration layer for agent team coordination
 * Based on OpenClaw Agent Teams Design (2026-02-23)
 */

import { TeamLedger } from "./ledger.js";
import type { Task, TeamMember, TeamMessage } from "./types.js";

/**
 * Extended Task interface with computed fields
 */
export interface TaskWithComputed extends Task {
  /** Array of task IDs blocked by this task */
  blocks?: string[];
  /** Unix timestamp when task was created */
  createdAt: number;
  /** Unix timestamp when task was claimed */
  claimedAt?: number;
  /** Unix timestamp when task was completed */
  completedAt?: number;
}

/**
 * Extended TeamMember interface with additional runtime fields
 */
export interface TeamMemberExtended extends TeamMember {
  /** Agent type for the member */
  agentType?: string;
  /** Current status: idle, working, blocked */
  status?: "idle" | "working" | "blocked";
  /** Current task assignment */
  currentTask?: string;
}

/**
 * TeamMessage interface with sender and recipient fields
 */
export interface TeamMessageExtended extends TeamMessage {
  /** Sender of the message */
  sender: string;
  /** Recipient of the message (empty for broadcast) */
  recipient?: string;
  /** Request ID for protocol messages */
  requestId?: string;
  /** Approval flag for protocol messages */
  approve?: boolean;
}

/**
 * Task claim result with optional blockedBy list
 */
export interface TaskClaimResultInternal {
  /** Whether claim was successful */
  success: boolean;
  /** ID of the task */
  taskId: string;
  /** Reason for failure */
  reason?: string;
  /** List of blocking task IDs when claim fails due to dependencies */
  blockedBy?: string[];
}

/**
 * Task creation options
 */
interface CreateTaskOptions {
  /** Active form for display */
  activeForm?: string;
  /** Task metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Team configuration interface
 */
interface TeamConfig {
  /** Team identifier */
  team_name: string;
  /** Team description */
  description?: string;
  /** Agent type for team lead */
  agent_type?: string;
}

/**
 * Complete team state for context injection
 */
interface TeamState {
  /** Team name */
  teamName: string;
  /** Team configuration */
  config: TeamConfig;
  /** All team members */
  members: TeamMemberExtended[];
  /** All tasks */
  tasks: TaskWithComputed[];
  /** All messages */
  messages: TeamMessageExtended[];
  /** Team status */
  status: "active" | "shutdown";
}

/**
 * Database row type for tasks
 */
interface TaskRow {
  id: string;
  subject: string;
  description: string;
  activeForm: string | null;
  status: string;
  owner: string | null;
  dependsOn: string | null;
  blockedBy: string | null;
  blocks: string | null;
  metadata: string | null;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
}

/**
 * Database row type for members
 */
interface MemberRow {
  sessionKey: string;
  agentId: string;
  name: string | null;
  role: string | null;
  agentType: string | null;
  status: string | null;
  currentTask: string | null;
  joinedAt: number;
  lastActiveAt: number | null;
}

/**
 * Database row type for messages
 */
interface MessageRow {
  id: string;
  fromSession: string;
  toSession: string;
  type: string;
  content: string;
  summary: string | null;
  requestId: string | null;
  approve: number | null;
  createdAt: number;
}

/**
 * Team Manager class
 * Provides high-level operations for task and member coordination
 */
export class TeamManager {
  private readonly ledger: TeamLedger;
  private readonly teamName: string;
  private readonly stateDir: string;
  private closed = false;

  constructor(teamName: string, stateDir: string) {
    this.teamName = teamName;
    this.stateDir = stateDir;
    this.ledger = new TeamLedger(teamName, stateDir);
    this.ledger.openDatabase();
  }

  /**
   * Create a new task with basic properties
   */
  createTask(subject: string, description: string, options?: CreateTaskOptions): TaskWithComputed {
    this.ensureOpen();

    const task: TaskWithComputed = {
      id: crypto.randomUUID(),
      subject,
      description,
      activeForm: options?.activeForm,
      metadata: options?.metadata,
      status: "pending",
      owner: "",
      dependsOn: [],
      blockedBy: [],
      blocks: [],
      createdAt: Date.now(),
    };

    this.saveTask(task);
    return task;
  }

  /**
   * List all tasks in the ledger
   */
  listTasks(): TaskWithComputed[] {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const rows = db
      .prepare(`
      SELECT
        id, subject, description, activeForm, status, owner,
        dependsOn, blockedBy, metadata, createdAt, claimedAt, completedAt
      FROM tasks
      ORDER BY createdAt
    `)
      .all();

    return rows.map((row) => this.taskFromRow(row as unknown as TaskRow));
  }

  /**
   * Claim a task for an agent
   */
  claimTask(taskId: string, agentName: string): TaskClaimResultInternal {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;

    if (!row) {
      return { success: false, taskId, reason: "Task not found" };
    }

    if (row.status === "completed") {
      return { success: false, taskId, reason: "Task is completed" };
    }

    if (row.status === "deleted") {
      return { success: false, taskId, reason: "Task is deleted" };
    }

    if (row.owner && row.owner !== agentName) {
      return { success: false, taskId, reason: "Task already claimed by another agent" };
    }

    const blockedBy = this.parseJsonArray(row.blockedBy);
    if (blockedBy.length > 0) {
      return { success: false, taskId, reason: "Task has unmet dependencies", blockedBy };
    }

    db.prepare("UPDATE tasks SET status = ?, owner = ?, claimedAt = ? WHERE id = ?").run(
      "in_progress",
      agentName,
      Date.now(),
      taskId,
    );

    return { success: true, taskId };
  }

  /**
   * Mark a task as completed
   */
  completeTask(taskId: string): boolean {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;

    if (!row) {
      return false;
    }

    if (row.status === "pending") {
      return false;
    }

    db.prepare("UPDATE tasks SET status = ?, completedAt = ? WHERE id = ?").run(
      "completed",
      Date.now(),
      taskId,
    );

    this.removeCompletedDependency(taskId);
    return true;
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: string): boolean {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const result = db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, taskId);

    return result.changes > 0;
  }

  /**
   * Delete a task from the ledger
   */
  deleteTask(taskId: string): boolean {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);

    return result.changes > 0;
  }

  /**
   * Add a dependency relationship between tasks
   */
  addTaskDependency(taskId: string, dependsOnId: string): boolean {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const taskRow = db.prepare("SELECT blockedBy FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    const dependsOnRow = db.prepare("SELECT blocks FROM tasks WHERE id = ?").get(dependsOnId) as
      | TaskRow
      | undefined;

    if (!taskRow || !dependsOnRow) {
      return false;
    }

    const blockedBy = this.parseJsonArray(taskRow.blockedBy);
    if (blockedBy.includes(dependsOnId)) {
      return true;
    }

    const newBlockedBy = [...blockedBy, dependsOnId];
    db.prepare("UPDATE tasks SET blockedBy = ? WHERE id = ?").run(
      JSON.stringify(newBlockedBy),
      taskId,
    );

    const dependsOnBlocks = this.parseJsonArray(dependsOnRow.blocks);
    if (!dependsOnBlocks.includes(taskId)) {
      const newBlocks = [...dependsOnBlocks, taskId];
      db.prepare("UPDATE tasks SET blocks = ? WHERE id = ?").run(
        JSON.stringify(newBlocks),
        dependsOnId,
      );
    }

    return true;
  }

  /**
   * Detect circular dependencies in the task graph
   */
  detectCircularDependencies(): string[][] {
    this.ensureOpen();

    const tasks = this.listTasks();
    const graph = new Map<string, string[]>();

    for (const task of tasks) {
      graph.set(task.id, task.blockedBy || []);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (node: string, path: string[]): boolean => {
      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const dependencies = graph.get(node) || [];
      for (const dep of dependencies) {
        if (!visited.has(dep)) {
          if (dfs(dep, [...path])) {
            return true;
          }
        } else if (recursionStack.has(dep)) {
          const cycleStart = path.indexOf(dep);
          cycles.push([...path.slice(cycleStart), dep]);
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        dfs(node, []);
      }
    }

    return cycles;
  }

  /**
   * Add a new member to the team with individual parameters
   */
  addMember(name: string, agentId: string, agentType: string): TeamMemberExtended;

  /**
   * Add a new member to the team with object parameter
   */
  addMember(params: {
    name: string;
    agentId: string;
    agentType?: string;
    status?: "idle" | "working" | "blocked";
  }): Promise<TeamMemberExtended>;

  /**
   * Add a new member to the team (implementation)
   */
  addMember(
    nameOrParams:
      | string
      | {
          name: string;
          agentId: string;
          agentType?: string;
          status?: "idle" | "working" | "blocked";
        },
    agentId?: string,
    agentType?: string,
  ): TeamMemberExtended | Promise<TeamMemberExtended> {
    this.ensureOpen();

    // Handle object parameter form
    if (typeof nameOrParams === "object") {
      const {
        name,
        agentId: objAgentId,
        agentType: objAgentType = "lead",
        status = "idle",
      } = nameOrParams;
      const member: TeamMemberExtended = {
        sessionKey: name,
        agentId: objAgentId,
        name,
        role: objAgentType === "lead" ? "lead" : "member",
        agentType: objAgentType,
        status,
        joinedAt: Date.now(),
      };
      this.saveMember(member);
      return Promise.resolve(member);
    }

    // Handle individual parameters form
    const member: TeamMemberExtended = {
      sessionKey: nameOrParams,
      agentId: agentId!,
      name: nameOrParams,
      role: agentType === "lead" ? "lead" : "member",
      agentType: agentType!,
      status: "idle",
      joinedAt: Date.now(),
    };
    this.saveMember(member);
    return member;
  }

  /**
   * List all team members
   */
  listMembers(): TeamMemberExtended[] {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const rows = db
      .prepare(`
      SELECT
        sessionKey, agentId, name, role, agentType, status, currentTask, joinedAt, lastActiveAt
      FROM members
      ORDER BY joinedAt
    `)
      .all();

    return rows.map((row) => this.memberFromRow(row as unknown as MemberRow));
  }

  /**
   * Update member activity status
   */
  updateMemberActivity(
    memberName: string,
    status?: "idle" | "working" | "blocked",
    currentTask?: string,
  ): boolean {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const existing = db.prepare("SELECT * FROM members WHERE sessionKey = ?").get(memberName);

    if (!existing) {
      return false;
    }

    const now = Date.now();
    const updates = ["lastActiveAt = ?"];
    const params: (number | string | null)[] = [now];

    if (status !== undefined) {
      updates.push("status = ?");
      params.push(status);
    }

    if (currentTask !== undefined) {
      updates.push("currentTask = ?");
      params.push(currentTask);
    } else if (status === "idle") {
      updates.push("currentTask = NULL");
    }

    params.push(memberName);

    const result = db
      .prepare(`UPDATE members SET ${updates.join(", ")} WHERE sessionKey = ?`)
      .run(...params);

    return result.changes > 0;
  }

  /**
   * Remove a member from the team
   */
  removeMember(memberName: string): void {
    this.ensureOpen();

    const db = this.ledger.getDb();
    db.prepare("DELETE FROM members WHERE sessionKey = ?").run(memberName);
  }

  /**
   * Store a message in the inbox
   */
  storeMessage(message: TeamMessageExtended): void {
    this.ensureOpen();

    const db = this.ledger.getDb();
    db.prepare(
      `INSERT INTO messages (id, fromSession, toSession, type, content, summary, requestId, approve, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.sender,
      message.recipient || "",
      message.type,
      message.content,
      message.summary || null,
      message.requestId || null,
      message.approve !== undefined ? (message.approve ? 1 : 0) : null,
      message.timestamp,
    );
  }

  /**
   * Retrieve messages for a recipient
   */
  retrieveMessages(recipient: string): TeamMessageExtended[] {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const rows = db
      .prepare(`
      SELECT
        id, fromSession, toSession, type, content, summary, requestId, approve, createdAt
      FROM messages
      WHERE toSession = ?
      ORDER BY createdAt
    `)
      .all(recipient);

    return rows.map((row) => this.messageFromRow(row as unknown as MessageRow));
  }

  /**
   * Mark a message as delivered
   */
  markMessageDelivered(messageId: string): boolean {
    this.ensureOpen();

    const db = this.ledger.getDb();
    const result = db.prepare("UPDATE messages SET delivered = 1 WHERE id = ?").run(messageId);

    return result.changes > 0;
  }

  /**
   * Clear all messages from the inbox
   */
  clearMessages(): void {
    this.ensureOpen();

    const db = this.ledger.getDb();
    db.prepare("DELETE FROM messages").run();
  }

  /**
   * Get complete team state for context injection
   */
  getTeamState(): TeamState {
    this.ensureOpen();

    return {
      teamName: this.teamName,
      config: {
        team_name: this.teamName,
        description: "Mock team",
        agent_type: "general-purpose",
      },
      members: this.listMembers(),
      tasks: this.listTasks(),
      messages: this.retrieveMessages(""),
      status: "active",
    };
  }

  /**
   * Close the manager and release database connection
   */
  close(): void {
    if (!this.closed) {
      this.ledger.close();
      this.closed = true;
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("TeamManager is closed");
    }
  }

  private saveTask(task: TaskWithComputed): void {
    const db = this.ledger.getDb();
    db.prepare(
      `INSERT INTO tasks (id, subject, description, activeForm, status, owner, dependsOn, blockedBy, metadata, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      task.id,
      task.subject,
      task.description,
      task.activeForm || null,
      task.status,
      task.owner || null,
      task.dependsOn ? JSON.stringify(task.dependsOn) : null,
      task.blockedBy ? JSON.stringify(task.blockedBy) : null,
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.createdAt,
    );
  }

  private saveMember(member: TeamMemberExtended): void {
    const db = this.ledger.getDb();
    const existing = db
      .prepare("SELECT * FROM members WHERE sessionKey = ?")
      .get(member.sessionKey);

    if (existing) {
      db.prepare(
        `UPDATE members SET agentId = ?, name = ?, role = ?, agentType = ?, status = ?, currentTask = ?, lastActiveAt = ? WHERE sessionKey = ?`,
      ).run(
        member.agentId,
        member.name ?? member.sessionKey,
        "member",
        member.agentType || null,
        member.status || null,
        member.currentTask || null,
        Date.now(),
        member.sessionKey,
      );
    } else {
      db.prepare(
        `INSERT INTO members (sessionKey, agentId, name, role, agentType, status, currentTask, joinedAt, lastActiveAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        member.sessionKey,
        member.agentId,
        member.name ?? member.sessionKey,
        "member",
        member.agentType || null,
        member.status || null,
        member.currentTask || null,
        member.joinedAt,
        Date.now(),
      );
    }
  }

  private taskFromRow(row: TaskRow): TaskWithComputed {
    return {
      id: row.id,
      subject: row.subject,
      description: row.description,
      activeForm: row.activeForm || undefined,
      status: row.status as TaskWithComputed["status"],
      owner: row.owner || "",
      dependsOn: row.dependsOn ? JSON.parse(row.dependsOn) : undefined,
      blockedBy: row.blockedBy ? JSON.parse(row.blockedBy) : [],
      blocks: row.blocks ? JSON.parse(row.blocks) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.createdAt,
      claimedAt: row.claimedAt || undefined,
      completedAt: row.completedAt || undefined,
    };
  }

  private memberFromRow(row: MemberRow): TeamMemberExtended {
    const member: TeamMemberExtended = {
      sessionKey: row.sessionKey,
      agentId: row.agentId,
      name: row.name || row.sessionKey,
      role: (row.role || "member") as "lead" | "member",
      joinedAt: row.joinedAt,
      lastActiveAt: row.lastActiveAt || undefined,
    };

    if (row.agentType) {
      member.agentType = row.agentType;
    }
    if (row.status) {
      member.status = row.status as "idle" | "working" | "blocked";
    }
    if (row.currentTask) {
      member.currentTask = row.currentTask;
    }

    return member;
  }

  private messageFromRow(row: MessageRow): TeamMessageExtended {
    const message: TeamMessageExtended = {
      id: row.id,
      from: row.fromSession,
      to: row.toSession || undefined,
      type: row.type as TeamMessageExtended["type"],
      content: row.content,
      summary: row.summary || undefined,
      sender: row.fromSession,
      recipient: row.toSession || "",
      timestamp: row.createdAt,
    };
    if (row.requestId) {
      message.requestId = row.requestId;
    }
    if (row.approve !== null) {
      message.approve = row.approve === 1;
    }
    return message;
  }

  private parseJsonArray(value: string | null): string[] {
    if (!value) {
      return [];
    }
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  private removeCompletedDependency(completedTaskId: string): void {
    const db = this.ledger.getDb();
    const completedRow = db.prepare("SELECT blocks FROM tasks WHERE id = ?").get(completedTaskId) as
      | TaskRow
      | undefined;

    if (!completedRow || !completedRow.blocks) {
      return;
    }

    const blocks = this.parseJsonArray(completedRow.blocks);

    for (const blockedTaskId of blocks) {
      const blockedRow = db
        .prepare("SELECT blockedBy FROM tasks WHERE id = ?")
        .get(blockedTaskId) as TaskRow | undefined;
      if (blockedRow && blockedRow.blockedBy) {
        const blockedBy = this.parseJsonArray(blockedRow.blockedBy);
        const newBlockedBy = blockedBy.filter((id) => id !== completedTaskId);
        db.prepare("UPDATE tasks SET blockedBy = ? WHERE id = ?").run(
          JSON.stringify(newBlockedBy),
          blockedTaskId,
        );
      }
    }
  }
}
