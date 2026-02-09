/**
 * OpenClaw AGI - Agent Kernel
 *
 * Core identity and state management for persistent agents.
 * Agents maintain identity, awareness, and state across sessions.
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/kernel
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getDatabase } from "../shared/db.js";

const log = createSubsystemLogger("agi:kernel");

// ============================================================================
// TYPES
// ============================================================================

export type AgentMode = "coding" | "research" | "planning" | "reviewing" | "idle" | "learning";

export type UserPresence = "online" | "away" | "dnd" | "unknown";

export interface PersonalityProfile {
  communicationStyle: "professional" | "friendly" | "concise" | "verbose" | "technical";
  humor: boolean;
  emojis: boolean;
  verbosity: "minimal" | "normal" | "detailed";
  proactiveLevel: "none" | "low" | "medium" | "high";
}

export interface AgentIdentity {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  lastActiveAt: Date;
  totalSessions: number;
  personality: PersonalityProfile;
}

export interface ActiveContext {
  id: string;
  type: "file" | "task" | "conversation" | "repository";
  name: string;
  path?: string;
  relevance: number; // 0-1
  lastAccessed: Date;
}

export interface AttentionFocus {
  currentFile?: string;
  currentTask?: string;
  currentLine?: number;
  currentColumn?: number;
}

export interface CodebaseSnapshot {
  repository?: string;
  branch?: string;
  commit?: string;
  lastIndexedAt?: Date;
  fileCount?: number;
  knownEntities?: string[];
}

export interface Environment {
  cwd: string;
  shell: string;
  nodeVersion: string;
  platform: string;
  toolsAvailable: string[];
}

export interface AgentState {
  mode: AgentMode;
  activeContexts: ActiveContext[];
  attentionFocus: AttentionFocus;
  userPresence: UserPresence;
  codebaseState: CodebaseSnapshot;
  environment: Environment;
}

export interface AgentKernel {
  identity: AgentIdentity;
  state: AgentState;
}

// ============================================================================
// AGENT KERNEL MANAGER
// ============================================================================

export class AgentKernelManager {
  private db: DatabaseSync;
  private agentId: string;
  private cache: Map<string, AgentIdentity | AgentState> = new Map();

  constructor(agentId: string, dbPath?: string) {
    this.agentId = agentId;
    // Use the shared DatabaseManager — one connection per agent
    this.db = getDatabase(agentId, dbPath);
    log.info(`AgentKernelManager initialized for agent: ${agentId}`);
  }

  // ============================================================================
  // AGENT IDENTITY
  // ============================================================================

  /** Create a new agent identity */
  createIdentity(config: {
    name: string;
    description?: string;
    personality?: Partial<PersonalityProfile>;
  }): AgentIdentity {
    const now = new Date().toISOString();
    const personality: PersonalityProfile = {
      communicationStyle: config.personality?.communicationStyle || "professional",
      humor: config.personality?.humor ?? false,
      emojis: config.personality?.emojis ?? false,
      verbosity: config.personality?.verbosity || "normal",
      proactiveLevel: config.personality?.proactiveLevel || "medium",
    };

    this.db
      .prepare(
        `INSERT INTO agent_kernel (
        id, name, description, created_at, last_active_at, total_sessions,
        personality_style, personality_humor, personality_emojis,
        personality_verbosity, personality_proactive
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.agentId,
        config.name,
        config.description || null,
        now,
        now,
        0,
        personality.communicationStyle,
        personality.humor ? 1 : 0,
        personality.emojis ? 1 : 0,
        personality.verbosity,
        personality.proactiveLevel,
      );

    log.info(`Created agent identity: ${config.name} (${this.agentId})`);

    const identity: AgentIdentity = {
      id: this.agentId,
      name: config.name,
      description: config.description,
      createdAt: new Date(now),
      lastActiveAt: new Date(now),
      totalSessions: 0,
      personality,
    };
    this.cache.set("identity", identity);
    return identity;
  }

  /** Load existing agent identity */
  loadIdentity(): AgentIdentity | null {
    const cached = this.cache.get("identity") as AgentIdentity | undefined;
    if (cached) {
      return cached;
    }

    const row = this.db.prepare("SELECT * FROM agent_kernel WHERE id = ?").get(this.agentId) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      log.debug(`No identity found for agent: ${this.agentId}`);
      return null;
    }

    const identity: AgentIdentity = {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      createdAt: new Date(row.created_at as string),
      lastActiveAt: new Date(row.last_active_at as string),
      totalSessions: row.total_sessions as number,
      personality: {
        communicationStyle: row.personality_style as PersonalityProfile["communicationStyle"],
        humor: Boolean(row.personality_humor),
        emojis: Boolean(row.personality_emojis),
        verbosity: row.personality_verbosity as PersonalityProfile["verbosity"],
        proactiveLevel: row.personality_proactive as PersonalityProfile["proactiveLevel"],
      },
    };
    this.cache.set("identity", identity);
    return identity;
  }

  /** Update agent activity timestamp */
  touch(): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE agent_kernel SET last_active_at = ? WHERE id = ?")
      .run(now, this.agentId);

    const identity = this.cache.get("identity") as AgentIdentity | undefined;
    if (identity) {
      identity.lastActiveAt = new Date(now);
    }
  }

  /** Increment session count */
  incrementSessions(): void {
    this.db
      .prepare("UPDATE agent_kernel SET total_sessions = total_sessions + 1 WHERE id = ?")
      .run(this.agentId);

    const identity = this.cache.get("identity") as AgentIdentity | undefined;
    if (identity) {
      identity.totalSessions++;
    }
  }

  // ============================================================================
  // AGENT STATE
  // ============================================================================

  /** Initialize or update agent state */
  initializeState(initial: Partial<AgentState> = {}): AgentState {
    const now = new Date().toISOString();

    const state: AgentState = {
      mode: initial.mode || "idle",
      activeContexts: initial.activeContexts || [],
      attentionFocus: initial.attentionFocus || {},
      userPresence: initial.userPresence || "unknown",
      codebaseState: initial.codebaseState || {},
      environment: initial.environment || detectEnvironment(),
    };

    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_state (
        agent_id, mode, current_file, current_task, current_line, current_column,
        user_presence, codebase_repository, codebase_branch, codebase_commit,
        codebase_last_indexed, codebase_file_count,
        env_cwd, env_shell, env_node_version, env_platform, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.agentId,
        state.mode,
        state.attentionFocus.currentFile || null,
        state.attentionFocus.currentTask || null,
        state.attentionFocus.currentLine || null,
        state.attentionFocus.currentColumn || null,
        state.userPresence,
        state.codebaseState.repository || null,
        state.codebaseState.branch || null,
        state.codebaseState.commit || null,
        state.codebaseState.lastIndexedAt?.toISOString() || null,
        state.codebaseState.fileCount || null,
        state.environment.cwd,
        state.environment.shell,
        state.environment.nodeVersion,
        state.environment.platform,
        now,
      );

    this.cache.set("state", state);
    log.info(`Initialized agent state: ${state.mode} mode`);
    return state;
  }

  /** Load current agent state */
  loadState(): AgentState | null {
    const cached = this.cache.get("state") as AgentState | undefined;
    if (cached) {
      return cached;
    }

    const row = this.db.prepare("SELECT * FROM agent_state WHERE agent_id = ?").get(this.agentId) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      return null;
    }

    const state: AgentState = {
      mode: row.mode as AgentMode,
      activeContexts: this.loadActiveContexts(),
      attentionFocus: {
        currentFile: (row.current_file as string) || undefined,
        currentTask: (row.current_task as string) || undefined,
        currentLine: (row.current_line as number) || undefined,
        currentColumn: (row.current_column as number) || undefined,
      },
      userPresence: row.user_presence as UserPresence,
      codebaseState: {
        repository: (row.codebase_repository as string) || undefined,
        branch: (row.codebase_branch as string) || undefined,
        commit: (row.codebase_commit as string) || undefined,
        lastIndexedAt: row.codebase_last_indexed
          ? new Date(row.codebase_last_indexed as string)
          : undefined,
        fileCount: (row.codebase_file_count as number) || undefined,
      },
      environment: {
        cwd: row.env_cwd as string,
        shell: row.env_shell as string,
        nodeVersion: row.env_node_version as string,
        platform: row.env_platform as string,
        toolsAvailable: [],
      },
    };

    this.cache.set("state", state);
    return state;
  }

  /** Update agent mode */
  setMode(mode: AgentMode): void {
    this.db
      .prepare("UPDATE agent_state SET mode = ?, updated_at = ? WHERE agent_id = ?")
      .run(mode, new Date().toISOString(), this.agentId);

    const state = this.cache.get("state") as AgentState | undefined;
    if (state) {
      state.mode = mode;
    }
    log.debug(`Agent mode changed to: ${mode}`);
  }

  /** Update attention focus */
  setFocus(focus: AttentionFocus): void {
    this.db
      .prepare(
        `UPDATE agent_state
       SET current_file = ?, current_task = ?, current_line = ?, current_column = ?, updated_at = ?
       WHERE agent_id = ?`,
      )
      .run(
        focus.currentFile || null,
        focus.currentTask || null,
        focus.currentLine || null,
        focus.currentColumn || null,
        new Date().toISOString(),
        this.agentId,
      );

    const state = this.cache.get("state") as AgentState | undefined;
    if (state) {
      state.attentionFocus = focus;
    }
  }

  /** Update user presence */
  setUserPresence(presence: UserPresence): void {
    this.db
      .prepare("UPDATE agent_state SET user_presence = ?, updated_at = ? WHERE agent_id = ?")
      .run(presence, new Date().toISOString(), this.agentId);

    const state = this.cache.get("state") as AgentState | undefined;
    if (state) {
      state.userPresence = presence;
    }
  }

  // ============================================================================
  // ACTIVE CONTEXTS
  // ============================================================================

  /** Add or update an active context */
  addContext(context: Omit<ActiveContext, "id" | "lastAccessed">): ActiveContext {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT OR REPLACE INTO active_contexts (
        id, agent_id, type, name, path, relevance, last_accessed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.agentId,
        context.type,
        context.name,
        context.path || null,
        context.relevance,
        now,
        now,
      );

    log.debug(`Added context: ${context.name} (${context.type})`);
    return { ...context, id, lastAccessed: new Date(now) };
  }

  /** Load all active contexts */
  loadActiveContexts(): ActiveContext[] {
    const rows = this.db
      .prepare("SELECT * FROM active_contexts WHERE agent_id = ? ORDER BY last_accessed DESC")
      .all(this.agentId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      type: row.type as ActiveContext["type"],
      name: row.name as string,
      path: row.path as string | undefined,
      relevance: row.relevance as number,
      lastAccessed: new Date(row.last_accessed as string),
    }));
  }

  /** Remove a context */
  removeContext(contextId: string): void {
    this.db
      .prepare("DELETE FROM active_contexts WHERE id = ? AND agent_id = ?")
      .run(contextId, this.agentId);
    log.debug(`Removed context: ${contextId}`);
  }

  /** Clear all contexts */
  clearContexts(): void {
    this.db.prepare("DELETE FROM active_contexts WHERE agent_id = ?").run(this.agentId);
    log.debug("Cleared all contexts");
  }

  // ============================================================================
  // ACCESSORS
  // ============================================================================

  /** Get complete agent kernel (identity + state) */
  getKernel(): AgentKernel | null {
    const identity = this.loadIdentity();
    const state = this.loadState();
    if (!identity) {
      return null;
    }
    return { identity, state: state || this.initializeState() };
  }

  getAgentId(): string {
    return this.agentId;
  }
}

// ============================================================================
// UTILITIES
// ============================================================================

function detectEnvironment(): Environment {
  return {
    cwd: process.cwd(),
    shell: process.env.SHELL || "unknown",
    nodeVersion: process.version,
    platform: process.platform,
    toolsAvailable: [],
  };
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

const kernelManagers = new Map<string, AgentKernelManager>();

export function getAgentKernel(agentId: string): AgentKernelManager {
  if (!kernelManagers.has(agentId)) {
    kernelManagers.set(agentId, new AgentKernelManager(agentId));
  }
  return kernelManagers.get(agentId)!;
}

export function createAgentKernel(config: {
  id?: string;
  name: string;
  description?: string;
  personality?: Partial<PersonalityProfile>;
}): AgentKernel {
  const id = config.id || randomUUID();
  const manager = new AgentKernelManager(id);
  const identity = manager.createIdentity({
    name: config.name,
    description: config.description,
    personality: config.personality,
  });
  const state = manager.initializeState();
  return { identity, state };
}

export function loadAgentKernel(agentId: string): AgentKernel | null {
  return getAgentKernel(agentId).getKernel();
}

/**
 * Resume an agent session. Detects new sessions based on a 5-minute
 * inactivity window and increments the session counter.
 */
export function resumeAgentSession(agentId: string): {
  kernel: AgentKernel;
  isNewSession: boolean;
} {
  const manager = getAgentKernel(agentId);
  let kernel = manager.getKernel();

  if (!kernel) {
    throw new Error(`Agent ${agentId} not found. Use createAgentKernel() first.`);
  }

  // New session = more than 5 min since last activity
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  const isNewSession = kernel.identity.lastActiveAt < fiveMinutesAgo;

  if (isNewSession) {
    manager.incrementSessions();
    log.info(
      `New session started for agent: ${agentId} (session #${kernel.identity.totalSessions + 1})`,
    );
  }

  manager.touch();
  manager.setUserPresence("online");
  kernel = manager.getKernel()!;

  return { kernel, isNewSession };
}
