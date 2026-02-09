/**
 * OpenClaw AGI - Database Manager
 *
 * Centralized database connection and schema management.
 * Ensures single database instance per agent with proper lifecycle management.
 *
 * Uses the OpenClaw state directory to resolve agent-specific DB paths
 * without requiring the full OpenClawConfig (which belongs to the gateway layer).
 *
 * @module agi/shared/db
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("agi:db");

// ============================================================================
// PATH RESOLUTION
// ============================================================================

/**
 * Resolve the AGI database path for an agent.
 *
 * Uses OPENCLAW_STATE_DIR (or legacy CLAWDBOT_STATE_DIR) env var when set,
 * otherwise falls back to ~/.openclaw/agents/<agentId>/agent/agi.db.
 *
 * This avoids importing the full config module, keeping AGI modules
 * decoupled from the gateway configuration layer.
 */
export function resolveAgiDbPath(agentId: string): string {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(process.env.HOME || process.env.USERPROFILE || ".", ".openclaw");

  const agentDir = path.join(stateDir, "agents", agentId, "agent");

  // Ensure directory exists before opening DB
  mkdirSync(agentDir, { recursive: true });

  return path.join(agentDir, "agi.db");
}

// ============================================================================
// SCHEMA DEFINITIONS
// ============================================================================

export const SCHEMA = {
  // Agent Kernel
  agentKernel: `
    CREATE TABLE IF NOT EXISTS agent_kernel (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      total_sessions INTEGER DEFAULT 0,
      personality_style TEXT DEFAULT 'professional',
      personality_humor INTEGER DEFAULT 0,
      personality_emojis INTEGER DEFAULT 0,
      personality_verbosity TEXT DEFAULT 'normal',
      personality_proactive TEXT DEFAULT 'medium'
    );
  `,

  agentState: `
    CREATE TABLE IF NOT EXISTS agent_state (
      agent_id TEXT PRIMARY KEY,
      mode TEXT DEFAULT 'idle',
      current_file TEXT,
      current_task TEXT,
      current_line INTEGER,
      current_column INTEGER,
      user_presence TEXT DEFAULT 'unknown',
      codebase_repository TEXT,
      codebase_branch TEXT,
      codebase_commit TEXT,
      codebase_last_indexed TEXT,
      codebase_file_count INTEGER,
      env_cwd TEXT,
      env_shell TEXT,
      env_node_version TEXT,
      env_platform TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agent_kernel(id)
    );
  `,

  activeContexts: `
    CREATE TABLE IF NOT EXISTS active_contexts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT,
      relevance REAL DEFAULT 1.0,
      last_accessed TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (agent_id) REFERENCES agent_kernel(id)
    );
  `,

  // Working Memory
  workingMemory: `
    CREATE TABLE IF NOT EXISTS working_memory (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_saved_at TEXT,
      intent_id TEXT,
      intent_description TEXT,
      intent_type TEXT,
      intent_priority TEXT,
      intent_status TEXT,
      intent_started_at TEXT,
      intent_estimated_completion TEXT,
      plan_id TEXT,
      plan_current_step INTEGER DEFAULT 0,
      plan_started_at TEXT,
      progress_percent REAL DEFAULT 0,
      progress_current_step TEXT,
      progress_items_processed INTEGER DEFAULT 0,
      progress_items_total INTEGER DEFAULT 0,
      progress_started_at TEXT,
      progress_estimated_completion TEXT
    );
  `,

  wmFiles: `
    CREATE TABLE IF NOT EXISTS wm_files (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content TEXT,
      checksum TEXT NOT NULL,
      important_lines TEXT,
      notes TEXT,
      last_accessed TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES working_memory(session_id)
    );
  `,

  wmTools: `
    CREATE TABLE IF NOT EXISTS wm_tools (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      params TEXT NOT NULL,
      result TEXT,
      error TEXT,
      duration INTEGER,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES working_memory(session_id)
    );
  `,

  wmDecisions: `
    CREATE TABLE IF NOT EXISTS wm_decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      context TEXT NOT NULL,
      what TEXT NOT NULL,
      why TEXT NOT NULL,
      alternatives TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES working_memory(session_id)
    );
  `,

  wmPlanSteps: `
    CREATE TABLE IF NOT EXISTS wm_plan_steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      started_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT,
      FOREIGN KEY (session_id) REFERENCES working_memory(session_id)
    );
  `,

  wmThoughts: `
    CREATE TABLE IF NOT EXISTS wm_thoughts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT DEFAULT 'reasoning',
      related_to TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES working_memory(session_id)
    );
  `,

  wmNotes: `
    CREATE TABLE IF NOT EXISTS wm_notes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      priority TEXT DEFAULT 'medium',
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES working_memory(session_id)
    );
  `,

  wmReminders: `
    CREATE TABLE IF NOT EXISTS wm_reminders (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      due_at TEXT,
      completed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES working_memory(session_id)
    );
  `,

  // Intents
  intents: `
    CREATE TABLE IF NOT EXISTS intents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      parent_id TEXT,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      estimated_time INTEGER DEFAULT 30,
      dependencies TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      blocked_reason TEXT,
      escalation_reason TEXT,
      metadata TEXT,
      FOREIGN KEY (parent_id) REFERENCES intents(id)
    );
  `,

  plans: `
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      current_step INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (intent_id) REFERENCES intents(id)
    );
  `,

  planSteps: `
    CREATE TABLE IF NOT EXISTS plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      estimated_time INTEGER DEFAULT 10,
      dependencies TEXT,
      blocked_reason TEXT,
      started_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );
  `,

  checkpoints: `
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      plan_id TEXT,
      step_id TEXT,
      timestamp TEXT NOT NULL,
      state TEXT NOT NULL,
      FOREIGN KEY (intent_id) REFERENCES intents(id)
    );
  `,

  // Graph Memory
  graphEntities: `
    CREATE TABLE IF NOT EXISTS graph_entities (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      file TEXT,
      line INTEGER,
      column_num INTEGER,
      end_line INTEGER,
      end_column INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,

  graphRelations: `
    CREATE TABLE IF NOT EXISTS graph_relations (
      id TEXT PRIMARY KEY,
      from_entity TEXT NOT NULL,
      to_entity TEXT NOT NULL,
      type TEXT NOT NULL,
      strength REAL DEFAULT 1.0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (from_entity) REFERENCES graph_entities(id),
      FOREIGN KEY (to_entity) REFERENCES graph_entities(id)
    );
  `,

  // Episodic Memory
  sessions: `
    CREATE TABLE IF NOT EXISTS agi_sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      intent TEXT,
      outcome TEXT DEFAULT 'ongoing',
      summary TEXT,
      embedding TEXT
    );
  `,

  events: `
    CREATE TABLE IF NOT EXISTS agi_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES agi_sessions(id)
    );
  `,

  episodes: `
    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      summary TEXT NOT NULL,
      entities TEXT,
      embedding TEXT,
      FOREIGN KEY (session_id) REFERENCES agi_sessions(id)
    );
  `,

  // Learning
  learnedPatterns: `
    CREATE TABLE IF NOT EXISTS learned_patterns (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      context TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      usage_count INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    );
  `,

  corrections: `
    CREATE TABLE IF NOT EXISTS corrections (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      mistake TEXT NOT NULL,
      correction TEXT NOT NULL,
      context TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
  `,

  preferences: `
    CREATE TABLE IF NOT EXISTS preferences (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      timestamp TEXT NOT NULL
    );
  `,

  // Proactive actions
  proactiveRules: `
    CREATE TABLE IF NOT EXISTS proactive_rules (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_condition TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_payload TEXT NOT NULL,
      priority TEXT DEFAULT 'medium',
      enabled INTEGER DEFAULT 1,
      cooldown_ms INTEGER DEFAULT 300000,
      last_fired_at TEXT,
      fire_count INTEGER DEFAULT 0,
      max_fires INTEGER DEFAULT 0,
      guard_expression TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,

  proactiveLog: `
    CREATE TABLE IF NOT EXISTS proactive_log (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      trigger_data TEXT,
      action_result TEXT,
      success INTEGER DEFAULT 1,
      error TEXT,
      FOREIGN KEY (rule_id) REFERENCES proactive_rules(id)
    );
  `,
} as const;

// ============================================================================
// INDEXES
// ============================================================================

export const INDEXES = {
  // Agent Kernel
  idx_agent_kernel_active: `CREATE INDEX IF NOT EXISTS idx_agent_kernel_active ON agent_kernel(last_active_at);`,

  // Working Memory
  idx_wm_agent: `CREATE INDEX IF NOT EXISTS idx_wm_agent ON working_memory(agent_id);`,
  idx_wm_saved: `CREATE INDEX IF NOT EXISTS idx_wm_saved ON working_memory(last_saved_at);`,
  idx_wm_files_session: `CREATE INDEX IF NOT EXISTS idx_wm_files_session ON wm_files(session_id);`,
  idx_wm_files_path: `CREATE INDEX IF NOT EXISTS idx_wm_files_path ON wm_files(path);`,

  // Intents
  idx_intents_agent: `CREATE INDEX IF NOT EXISTS idx_intents_agent ON intents(agent_id);`,
  idx_intents_status: `CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);`,
  idx_intents_priority: `CREATE INDEX IF NOT EXISTS idx_intents_priority ON intents(priority);`,
  idx_intents_parent: `CREATE INDEX IF NOT EXISTS idx_intents_parent ON intents(parent_id);`,
  idx_plans_intent: `CREATE INDEX IF NOT EXISTS idx_plans_intent ON plans(intent_id);`,
  idx_plan_steps_plan: `CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);`,

  // Graph
  idx_graph_entities_agent: `CREATE INDEX IF NOT EXISTS idx_graph_entities_agent ON graph_entities(agent_id);`,
  idx_graph_entities_type: `CREATE INDEX IF NOT EXISTS idx_graph_entities_type ON graph_entities(type);`,
  idx_graph_entities_name: `CREATE INDEX IF NOT EXISTS idx_graph_entities_name ON graph_entities(name);`,
  idx_graph_relations_from: `CREATE INDEX IF NOT EXISTS idx_graph_relations_from ON graph_relations(from_entity);`,
  idx_graph_relations_to: `CREATE INDEX IF NOT EXISTS idx_graph_relations_to ON graph_relations(to_entity);`,

  // Sessions (Episodic)
  idx_sessions_agent: `CREATE INDEX IF NOT EXISTS idx_agi_sessions_agent ON agi_sessions(agent_id);`,
  idx_sessions_time: `CREATE INDEX IF NOT EXISTS idx_agi_sessions_time ON agi_sessions(start_time);`,
  idx_events_session: `CREATE INDEX IF NOT EXISTS idx_agi_events_session ON agi_events(session_id);`,
  idx_episodes_session: `CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);`,

  // Learning
  idx_patterns_agent: `CREATE INDEX IF NOT EXISTS idx_patterns_agent ON learned_patterns(agent_id);`,
  idx_corrections_agent: `CREATE INDEX IF NOT EXISTS idx_corrections_agent ON corrections(agent_id);`,
  idx_preferences_agent: `CREATE INDEX IF NOT EXISTS idx_preferences_agent ON preferences(agent_id);`,
  idx_preferences_key: `CREATE INDEX IF NOT EXISTS idx_preferences_key ON preferences(agent_id, category, key);`,

  // Proactive
  idx_proactive_rules_agent: `CREATE INDEX IF NOT EXISTS idx_proactive_rules_agent ON proactive_rules(agent_id);`,
  idx_proactive_log_rule: `CREATE INDEX IF NOT EXISTS idx_proactive_log_rule ON proactive_log(rule_id);`,
} as const;

// ============================================================================
// DATABASE MANAGER
// ============================================================================

/**
 * Centralized database connection manager.
 *
 * Maintains a single connection per agent and initializes all AGI schemas
 * on first access. All AGI modules MUST use this instead of creating
 * their own DatabaseSync instances to avoid SQLITE_BUSY under load.
 */
export class DatabaseManager {
  private static instances = new Map<string, DatabaseSync>();
  private agentId: string;
  private db: DatabaseSync;

  constructor(agentId: string, dbPath?: string) {
    this.agentId = agentId;

    // Return existing instance if available
    if (DatabaseManager.instances.has(agentId)) {
      this.db = DatabaseManager.instances.get(agentId)!;
      log.debug(`Reusing existing database connection for agent: ${agentId}`);
    } else {
      const resolvedPath = dbPath || resolveAgiDbPath(agentId);
      this.db = new DatabaseSync(resolvedPath);
      // Enable WAL mode for better concurrent read performance
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      DatabaseManager.instances.set(agentId, this.db);
      log.info(`Created new database connection for agent: ${agentId}`);
    }

    this.initializeSchema();
  }

  private initializeSchema(): void {
    for (const sql of Object.values(SCHEMA)) {
      this.db.exec(sql);
    }
    for (const sql of Object.values(INDEXES)) {
      this.db.exec(sql);
    }
    log.debug("Database schema initialized");
  }

  getDatabase(): DatabaseSync {
    return this.db;
  }

  getAgentId(): string {
    return this.agentId;
  }

  static closeAll(): void {
    for (const [agentId, db] of DatabaseManager.instances) {
      try {
        db.close();
        log.info(`Closed database connection for agent: ${agentId}`);
      } catch (error) {
        log.error(`Error closing database for agent ${agentId}`, { error: String(error) });
      }
    }
    DatabaseManager.instances.clear();
  }

  static close(agentId: string): void {
    const db = DatabaseManager.instances.get(agentId);
    if (db) {
      try {
        db.close();
        DatabaseManager.instances.delete(agentId);
        log.info(`Closed database connection for agent: ${agentId}`);
      } catch (error) {
        log.error(`Error closing database for agent ${agentId}`, { error: String(error) });
      }
    }
  }

  /**
   * Check if a connection already exists for the given agent.
   */
  static has(agentId: string): boolean {
    return DatabaseManager.instances.has(agentId);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get or create a shared database connection for the given agent.
 * All AGI modules should call this instead of new DatabaseSync().
 */
export function getDatabase(agentId: string, dbPath?: string): DatabaseSync {
  const manager = new DatabaseManager(agentId, dbPath);
  return manager.getDatabase();
}

export function jsonToSql(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

export function sqlToJson<T>(value: string | null): T | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function dateToSql(date: Date | undefined): string | null {
  if (!date) {
    return null;
  }
  return date.toISOString();
}

export function sqlToDate(value: string | null): Date | undefined {
  if (!value) {
    return undefined;
  }
  return new Date(value);
}

export function booleanToSql(value: boolean): number {
  return value ? 1 : 0;
}

export function sqlToBoolean(value: number | null): boolean {
  return value === 1;
}
