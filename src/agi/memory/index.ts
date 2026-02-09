/**
 * OpenClaw AGI - Working Memory
 *
 * Short-term, high-fidelity context of current session.
 * Auto-saves to SQLite and fully restores on session resume.
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/memory
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentMode } from "../kernel/index.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getDatabase, jsonToSql, sqlToJson, dateToSql, sqlToDate } from "../shared/db.js";

const log = createSubsystemLogger("agi:memory");

// ============================================================================
// TYPES
// ============================================================================

export interface FileContext {
  path: string;
  content?: string;
  checksum: string;
  importantLines?: number[];
  notes?: string;
  lastAccessed: Date;
}

export interface ToolInvocation {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration: number;
  timestamp: Date;
}

export interface Decision {
  id: string;
  context: string;
  what: string;
  why: string;
  alternatives?: string[];
  timestamp: Date;
}

export interface Thought {
  id: string;
  content: string;
  type: "reasoning" | "observation" | "hypothesis" | "conclusion";
  relatedTo?: string;
  timestamp: Date;
}

export interface Note {
  id: string;
  content: string;
  category?: string;
  priority?: "low" | "medium" | "high";
  timestamp: Date;
}

export interface Reminder {
  id: string;
  content: string;
  dueAt?: Date;
  completed: boolean;
  createdAt: Date;
}

export interface ActiveIntent {
  id: string;
  description: string;
  type: "implement" | "fix" | "research" | "review" | "refactor" | "other";
  priority: "critical" | "high" | "medium" | "low";
  status: "active" | "blocked" | "completed" | "abandoned";
  startedAt: Date;
  estimatedCompletion?: Date;
}

export interface ExecutionPlan {
  id: string;
  steps: PlanStep[];
  currentStepIndex: number;
  startedAt: Date;
}

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "failed";
  startedAt?: Date;
  completedAt?: Date;
  result?: unknown;
  error?: string;
}

export interface Progress {
  overallPercent: number;
  currentStep?: string;
  itemsProcessed?: number;
  itemsTotal?: number;
  startedAt: Date;
  estimatedCompletion?: Date;
}

export interface WorkingMemoryState {
  filesOpen: Map<string, FileContext>;
  toolsUsed: ToolInvocation[];
  decisions: Decision[];
  intent?: ActiveIntent;
  plan?: ExecutionPlan;
  progress?: Progress;
  thoughts: Thought[];
  notes: Note[];
  reminders: Reminder[];
  sessionId: string;
  agentId: string;
  startedAt: Date;
  lastSavedAt?: Date;
}

// ============================================================================
// WORKING MEMORY MANAGER
// ============================================================================

export class WorkingMemoryManager {
  private db: DatabaseSync;
  private agentId: string;
  private sessionId: string;
  private memory: WorkingMemoryState;
  private autoSaveInterval?: ReturnType<typeof setInterval>;
  private checkpointCallbacks: Set<() => void> = new Set();

  constructor(agentId: string, sessionId?: string, dbPath?: string) {
    this.agentId = agentId;
    this.sessionId = sessionId || randomUUID();
    this.db = getDatabase(agentId, dbPath);

    // Initialize empty memory state
    this.memory = {
      sessionId: this.sessionId,
      agentId: this.agentId,
      startedAt: new Date(),
      filesOpen: new Map(),
      toolsUsed: [],
      decisions: [],
      thoughts: [],
      notes: [],
      reminders: [],
    };

    log.info(`WorkingMemoryManager initialized for session: ${this.sessionId}`);
  }

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================

  /** Start a new working memory session */
  startSession(): WorkingMemoryState {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO working_memory (
        session_id, agent_id, started_at, last_saved_at,
        progress_percent, progress_items_processed, progress_items_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.sessionId, this.agentId, now, now, 0, 0, 0);

    this.memory.startedAt = new Date(now);
    this.memory.lastSavedAt = new Date(now);
    log.info(`Started new working memory session: ${this.sessionId}`);
    return this.memory;
  }

  /** Restore a previous session from database */
  restoreSession(sessionId: string): WorkingMemoryState | null {
    const row = this.db
      .prepare("SELECT * FROM working_memory WHERE session_id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;

    if (!row) {
      log.warn(`Session ${sessionId} not found`);
      return null;
    }

    this.sessionId = sessionId;
    this.memory.sessionId = sessionId;
    this.memory.startedAt = new Date(row.started_at as string);
    this.memory.lastSavedAt = row.last_saved_at ? new Date(row.last_saved_at as string) : undefined;

    // Restore sub-records
    this.restoreIntent(row);
    this.restorePlan(row);
    this.restoreProgress(row);
    this.restoreFiles(sessionId);
    this.restoreTools(sessionId);
    this.restoreDecisions(sessionId);
    this.restoreThoughts(sessionId);
    this.restoreNotes(sessionId);
    this.restoreReminders(sessionId);

    log.info(
      `Restored session ${sessionId} with ${this.memory.filesOpen.size} files, ${this.memory.toolsUsed.length} tool calls`,
    );
    return this.memory;
  }

  /** Get the latest session for an agent */
  getLatestSession(): string | null {
    const row = this.db
      .prepare(
        "SELECT session_id FROM working_memory WHERE agent_id = ? ORDER BY last_saved_at DESC LIMIT 1",
      )
      .get(this.agentId) as { session_id: string } | undefined;
    return row?.session_id || null;
  }

  // ============================================================================
  // AUTO-SAVE
  // ============================================================================

  /** Enable auto-save every N seconds */
  enableAutoSave(intervalSeconds = 30): void {
    this.disableAutoSave();
    this.autoSaveInterval = setInterval(() => this.save(), intervalSeconds * 1000);
    log.debug(`Auto-save enabled: every ${intervalSeconds}s`);
  }

  /** Disable auto-save */
  disableAutoSave(): void {
    if (this.autoSaveInterval) {
      clearInterval(this.autoSaveInterval);
      this.autoSaveInterval = undefined;
      log.debug("Auto-save disabled");
    }
  }

  /** Persist current state to database */
  save(): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE working_memory SET
        last_saved_at = ?,
        intent_status = ?,
        plan_current_step = ?,
        progress_percent = ?,
        progress_items_processed = ?,
        progress_items_total = ?,
        progress_current_step = ?
      WHERE session_id = ?`,
      )
      .run(
        now,
        this.memory.intent?.status || null,
        this.memory.plan?.currentStepIndex || 0,
        this.memory.progress?.overallPercent || 0,
        this.memory.progress?.itemsProcessed || 0,
        this.memory.progress?.itemsTotal || 0,
        this.memory.progress?.currentStep || null,
        this.sessionId,
      );

    this.memory.lastSavedAt = new Date(now);

    // Notify checkpoint listeners
    for (const cb of this.checkpointCallbacks) {
      try {
        cb();
      } catch {
        /* best-effort */
      }
    }
    log.debug(`Working memory saved: ${this.sessionId}`);
  }

  /** Register a callback on each checkpoint */
  onCheckpoint(callback: () => void): () => void {
    this.checkpointCallbacks.add(callback);
    return () => this.checkpointCallbacks.delete(callback);
  }

  // ============================================================================
  // MEMORY OPERATIONS
  // ============================================================================

  /** Record a file that has been opened/read */
  recordFile(
    filePath: string,
    content?: string,
    options?: { importantLines?: number[]; notes?: string },
  ): void {
    const checksum = simpleChecksum(content || "");
    const now = new Date().toISOString();

    this.memory.filesOpen.set(filePath, {
      path: filePath,
      content,
      checksum,
      importantLines: options?.importantLines,
      notes: options?.notes,
      lastAccessed: new Date(now),
    });

    this.db
      .prepare(
        `INSERT OR REPLACE INTO wm_files (id, session_id, path, content, checksum, important_lines, notes, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        this.sessionId,
        filePath,
        content || null,
        checksum,
        jsonToSql(options?.importantLines),
        options?.notes || null,
        now,
      );
    log.debug(`Recorded file: ${filePath}`);
  }

  /** Record a tool invocation */
  recordTool(
    tool: string,
    params: Record<string, unknown>,
    result: unknown,
    duration: number,
  ): void {
    const invocation: ToolInvocation = {
      id: randomUUID(),
      tool,
      params,
      result,
      duration,
      timestamp: new Date(),
    };
    this.memory.toolsUsed.push(invocation);

    this.db
      .prepare(
        `INSERT INTO wm_tools (id, session_id, tool, params, result, duration, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invocation.id,
        this.sessionId,
        tool,
        jsonToSql(params),
        jsonToSql(result),
        duration,
        invocation.timestamp.toISOString(),
      );
    log.debug(`Recorded tool: ${tool}`);
  }

  /** Record a decision */
  recordDecision(context: string, what: string, why: string, alternatives?: string[]): void {
    const decision: Decision = {
      id: randomUUID(),
      context,
      what,
      why,
      alternatives,
      timestamp: new Date(),
    };
    this.memory.decisions.push(decision);

    this.db
      .prepare(
        `INSERT INTO wm_decisions (id, session_id, context, what, why, alternatives, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        this.sessionId,
        context,
        what,
        why,
        jsonToSql(alternatives),
        decision.timestamp.toISOString(),
      );
    log.debug(`Recorded decision: ${what}`);
  }

  /** Record a thought/reasoning */
  recordThought(content: string, type: Thought["type"] = "reasoning", relatedTo?: string): void {
    const thought: Thought = {
      id: randomUUID(),
      content,
      type,
      relatedTo,
      timestamp: new Date(),
    };
    this.memory.thoughts.push(thought);

    this.db
      .prepare(
        `INSERT INTO wm_thoughts (id, session_id, content, type, related_to, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thought.id,
        this.sessionId,
        content,
        type,
        relatedTo || null,
        thought.timestamp.toISOString(),
      );
  }

  /** Add a note */
  addNote(content: string, category?: string, priority: Note["priority"] = "medium"): Note {
    const note: Note = {
      id: randomUUID(),
      content,
      category,
      priority,
      timestamp: new Date(),
    };
    this.memory.notes.push(note);

    this.db
      .prepare(
        `INSERT INTO wm_notes (id, session_id, content, category, priority, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        note.id,
        this.sessionId,
        content,
        category || null,
        priority,
        note.timestamp.toISOString(),
      );
    return note;
  }

  /** Add a reminder */
  addReminder(content: string, dueAt?: Date): Reminder {
    const reminder: Reminder = {
      id: randomUUID(),
      content,
      dueAt,
      completed: false,
      createdAt: new Date(),
    };
    this.memory.reminders.push(reminder);

    this.db
      .prepare(
        `INSERT INTO wm_reminders (id, session_id, content, due_at, completed, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reminder.id,
        this.sessionId,
        content,
        dateToSql(dueAt),
        0,
        reminder.createdAt.toISOString(),
      );
    return reminder;
  }

  /** Mark reminder as complete */
  completeReminder(reminderId: string): void {
    const reminder = this.memory.reminders.find((r) => r.id === reminderId);
    if (reminder) {
      reminder.completed = true;
      this.db.prepare("UPDATE wm_reminders SET completed = 1 WHERE id = ?").run(reminderId);
    }
  }

  // ============================================================================
  // INTENT & PLAN
  // ============================================================================

  /** Set current intent */
  setIntent(intent: Omit<ActiveIntent, "id" | "startedAt">): ActiveIntent {
    const fullIntent: ActiveIntent = {
      ...intent,
      id: randomUUID(),
      startedAt: new Date(),
    };
    this.memory.intent = fullIntent;

    this.db
      .prepare(
        `UPDATE working_memory SET
        intent_id = ?, intent_description = ?, intent_type = ?,
        intent_priority = ?, intent_status = ?, intent_started_at = ?,
        intent_estimated_completion = ?
      WHERE session_id = ?`,
      )
      .run(
        fullIntent.id,
        fullIntent.description,
        fullIntent.type,
        fullIntent.priority,
        fullIntent.status,
        fullIntent.startedAt.toISOString(),
        dateToSql(fullIntent.estimatedCompletion),
        this.sessionId,
      );

    log.info(`Intent set: ${fullIntent.description}`);
    return fullIntent;
  }

  /** Create execution plan */
  createPlan(steps: string[]): ExecutionPlan {
    const planId = randomUUID();
    const now = new Date().toISOString();

    const plan: ExecutionPlan = {
      id: planId,
      steps: steps.map((desc, index) => ({
        id: randomUUID(),
        description: desc,
        status: index === 0 ? "in_progress" : "pending",
        startedAt: index === 0 ? new Date() : undefined,
      })),
      currentStepIndex: 0,
      startedAt: new Date(),
    };

    this.memory.plan = plan;

    this.db
      .prepare(
        "UPDATE working_memory SET plan_id = ?, plan_current_step = ?, plan_started_at = ? WHERE session_id = ?",
      )
      .run(planId, 0, now, this.sessionId);

    const stepStmt = this.db.prepare(
      `INSERT INTO wm_plan_steps (id, session_id, plan_id, step_index, description, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      stepStmt.run(
        step.id,
        this.sessionId,
        planId,
        i,
        step.description,
        step.status,
        step.startedAt?.toISOString() || null,
      );
    }

    log.info(`Created plan with ${steps.length} steps`);
    return plan;
  }

  /** Mark current step complete and advance */
  completeCurrentStep(result?: unknown): void {
    if (!this.memory.plan) {
      return;
    }
    const step = this.memory.plan.steps[this.memory.plan.currentStepIndex];
    if (!step) {
      return;
    }

    const now = new Date().toISOString();
    step.status = "completed";
    step.completedAt = new Date();
    step.result = result;

    this.db
      .prepare("UPDATE wm_plan_steps SET status = ?, completed_at = ?, result = ? WHERE id = ?")
      .run("completed", now, jsonToSql(result), step.id);

    // Advance to next step
    this.memory.plan.currentStepIndex++;
    const nextStep = this.memory.plan.steps[this.memory.plan.currentStepIndex];
    if (nextStep) {
      nextStep.status = "in_progress";
      nextStep.startedAt = new Date();
      this.db
        .prepare("UPDATE wm_plan_steps SET status = ?, started_at = ? WHERE id = ?")
        .run("in_progress", now, nextStep.id);
      this.db
        .prepare("UPDATE working_memory SET plan_current_step = ? WHERE session_id = ?")
        .run(this.memory.plan.currentStepIndex, this.sessionId);
      log.info(
        `Advanced to step ${this.memory.plan.currentStepIndex + 1}: ${nextStep.description}`,
      );
    } else {
      log.info("All plan steps completed");
    }
  }

  /** Update progress */
  updateProgress(
    percent: number,
    currentStep?: string,
    itemsProcessed?: number,
    itemsTotal?: number,
  ): void {
    this.memory.progress = {
      overallPercent: percent,
      currentStep: currentStep || this.memory.progress?.currentStep,
      itemsProcessed: itemsProcessed ?? this.memory.progress?.itemsProcessed,
      itemsTotal: itemsTotal ?? this.memory.progress?.itemsTotal,
      startedAt: this.memory.progress?.startedAt || new Date(),
    };
    this.save();
  }

  // ============================================================================
  // ACCESSORS
  // ============================================================================

  getMemory(): WorkingMemoryState {
    return this.memory;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getRecentFiles(limit = 10): FileContext[] {
    return Array.from(this.memory.filesOpen.values())
      .toSorted((a, b) => b.lastAccessed.getTime() - a.lastAccessed.getTime())
      .slice(0, limit);
  }

  getRecentTools(limit = 20): ToolInvocation[] {
    return this.memory.toolsUsed.slice(-limit);
  }

  getPendingReminders(): Reminder[] {
    return this.memory.reminders.filter((r) => !r.completed);
  }

  // ============================================================================
  // CLEANUP
  // ============================================================================

  close(): void {
    this.disableAutoSave();
    this.save();
    log.info(`WorkingMemoryManager closed for session: ${this.sessionId}`);
  }

  // ============================================================================
  // PRIVATE RESTORE HELPERS (DRY extraction)
  // ============================================================================

  private restoreIntent(row: Record<string, unknown>): void {
    if (!row.intent_id) {
      return;
    }
    this.memory.intent = {
      id: row.intent_id as string,
      description: row.intent_description as string,
      type: row.intent_type as ActiveIntent["type"],
      priority: row.intent_priority as ActiveIntent["priority"],
      status: row.intent_status as ActiveIntent["status"],
      startedAt: new Date(row.intent_started_at as string),
      estimatedCompletion: sqlToDate(row.intent_estimated_completion as string | null),
    };
  }

  private restorePlan(row: Record<string, unknown>): void {
    if (!row.plan_id) {
      return;
    }
    const stepRows = this.db
      .prepare("SELECT * FROM wm_plan_steps WHERE session_id = ? ORDER BY step_index")
      .all(this.sessionId) as Array<Record<string, unknown>>;

    this.memory.plan = {
      id: row.plan_id as string,
      steps: stepRows.map((sr) => ({
        id: sr.id as string,
        description: sr.description as string,
        status: sr.status as PlanStep["status"],
        startedAt: sqlToDate(sr.started_at as string | null),
        completedAt: sqlToDate(sr.completed_at as string | null),
        result: sqlToJson(sr.result as string | null),
        error: sr.error as string | undefined,
      })),
      currentStepIndex: row.plan_current_step as number,
      startedAt: new Date(row.plan_started_at as string),
    };
  }

  private restoreProgress(row: Record<string, unknown>): void {
    if (!row.progress_started_at) {
      return;
    }
    this.memory.progress = {
      overallPercent: row.progress_percent as number,
      currentStep: row.progress_current_step as string | undefined,
      itemsProcessed: row.progress_items_processed as number,
      itemsTotal: row.progress_items_total as number,
      startedAt: new Date(row.progress_started_at as string),
      estimatedCompletion: sqlToDate(row.progress_estimated_completion as string | null),
    };
  }

  private restoreFiles(sessionId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM wm_files WHERE session_id = ?")
      .all(sessionId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      this.memory.filesOpen.set(row.path as string, {
        path: row.path as string,
        content: row.content as string | undefined,
        checksum: row.checksum as string,
        importantLines: sqlToJson<number[]>(row.important_lines as string | null),
        notes: row.notes as string | undefined,
        lastAccessed: new Date(row.last_accessed as string),
      });
    }
  }

  private restoreTools(sessionId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM wm_tools WHERE session_id = ? ORDER BY timestamp")
      .all(sessionId) as Array<Record<string, unknown>>;
    this.memory.toolsUsed = rows.map((row) => ({
      id: row.id as string,
      tool: row.tool as string,
      params: sqlToJson<Record<string, unknown>>(row.params as string) || {},
      result: sqlToJson(row.result as string | null),
      error: row.error as string | undefined,
      duration: row.duration as number,
      timestamp: new Date(row.timestamp as string),
    }));
  }

  private restoreDecisions(sessionId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM wm_decisions WHERE session_id = ? ORDER BY timestamp")
      .all(sessionId) as Array<Record<string, unknown>>;
    this.memory.decisions = rows.map((row) => ({
      id: row.id as string,
      context: row.context as string,
      what: row.what as string,
      why: row.why as string,
      alternatives: sqlToJson<string[]>(row.alternatives as string | null),
      timestamp: new Date(row.timestamp as string),
    }));
  }

  private restoreThoughts(sessionId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM wm_thoughts WHERE session_id = ? ORDER BY timestamp")
      .all(sessionId) as Array<Record<string, unknown>>;
    this.memory.thoughts = rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      type: row.type as Thought["type"],
      relatedTo: row.related_to as string | undefined,
      timestamp: new Date(row.timestamp as string),
    }));
  }

  private restoreNotes(sessionId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM wm_notes WHERE session_id = ? ORDER BY timestamp")
      .all(sessionId) as Array<Record<string, unknown>>;
    this.memory.notes = rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      category: row.category as string | undefined,
      priority: row.priority as Note["priority"],
      timestamp: new Date(row.timestamp as string),
    }));
  }

  private restoreReminders(sessionId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM wm_reminders WHERE session_id = ?")
      .all(sessionId) as Array<Record<string, unknown>>;
    this.memory.reminders = rows.map((row) => ({
      id: row.id as string,
      content: row.content as string,
      dueAt: sqlToDate(row.due_at as string | null),
      completed: Boolean(row.completed),
      createdAt: new Date(row.created_at as string),
    }));
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

/** Fast non-crypto checksum for change detection */
function simpleChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit int
  }
  return hash.toString(16);
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

const memoryManagers = new Map<string, WorkingMemoryManager>();

export function getWorkingMemory(agentId: string, sessionId?: string): WorkingMemoryManager {
  const key = `${agentId}:${sessionId || "current"}`;
  if (!memoryManagers.has(key)) {
    memoryManagers.set(key, new WorkingMemoryManager(agentId, sessionId));
  }
  return memoryManagers.get(key)!;
}

export function startWorkingMemorySession(agentId: string): {
  manager: WorkingMemoryManager;
  state: WorkingMemoryState;
} {
  const manager = new WorkingMemoryManager(agentId);
  const state = manager.startSession();
  manager.enableAutoSave(30);
  return { manager, state };
}

export function restoreWorkingMemorySession(
  agentId: string,
  sessionId?: string,
): {
  manager: WorkingMemoryManager;
  state: WorkingMemoryState | null;
  isNew: boolean;
} {
  const manager = getWorkingMemory(agentId, sessionId);
  const targetSessionId = sessionId || manager.getLatestSession();

  if (targetSessionId) {
    const state = manager.restoreSession(targetSessionId);
    if (state) {
      manager.enableAutoSave(30);
      return { manager, state, isNew: false };
    }
  }

  const state = manager.startSession();
  manager.enableAutoSave(30);
  return { manager, state, isNew: true };
}

// Re-export AgentMode for downstream convenience
export type { AgentMode };
