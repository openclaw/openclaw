/**
 * Parallel Session Manager
 *
 * Manages concurrent agent sessions with shared memory backend.
 * Each channel/chat can have its own isolated session context while
 * sharing a common knowledge base.
 *
 * SQLite-first architecture: no in-memory arrays for memories or knowledge.
 * SQLite is the sole source of truth. Sessions use a bounded LRU cache.
 */

import { EventEmitter } from "node:events";
import type { ParallelSessionsConfig } from "../config/parallel-sessions-config.js";
import { DEFAULT_PARALLEL_SESSIONS_CONFIG } from "../config/parallel-sessions-config.js";
import type { SharedMemoryBackend } from "./shared-memory-backend.js";

export interface SessionState {
  sessionKey: string;
  channelId: string;
  chatId?: string;
  peerId?: string;
  status: "active" | "idle" | "hibernated";
  lastActivityAt: number;
  createdAt: number;
  messageCount: number;
}

export interface SessionMemoryEntry {
  id?: number;
  sessionKey: string;
  channelId: string;
  memoryType: "decision" | "preference" | "summary" | "fact" | "action";
  content: string;
  importance: number; // 1-10
  createdAt: number;
  expiresAt?: number;
  promotedToGlobal: boolean;
}

export interface GlobalKnowledgeEntry {
  id?: number;
  category: string;
  content: string;
  sourceChannel: string;
  sourceSessionKey: string;
  confidence: number; // 0-1
  createdAt: number;
  updatedAt: number;
}

export interface WorkItem {
  id?: number;
  sessionKey: string;
  channelId: string;
  description: string;
  /** What the executor should do — structured payload */
  payload: Record<string, unknown>;
  status: "scheduled" | "ready" | "executing" | "completed" | "failed" | "cancelled";
  priority: number; // 1-10
  /** When to start (epoch ms). null = immediately ready */
  scheduledFor?: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Progress percentage 0-100, updated by executor */
  progressPct?: number;
  /** Summary of result or error */
  resultSummary?: string;
  /** How many times execution has been attempted */
  attempts: number;
  /** Max retry attempts before marking failed */
  maxAttempts: number;
}

/**
 * Manages parallel agent sessions with shared memory.
 * SQLite-first: no in-memory arrays for memories or knowledge.
 */
export class ParallelSessionManager extends EventEmitter {
  private config: ParallelSessionsConfig;
  private sessions: Map<string, SessionState> = new Map();
  // sessionMemory and globalKnowledge arrays REMOVED — SQLite is source of truth
  private idleCheckInterval?: ReturnType<typeof setInterval>;
  private backend: SharedMemoryBackend | null;

  constructor(config: Partial<ParallelSessionsConfig> = {}, backend?: SharedMemoryBackend) {
    super();
    this.config = { ...DEFAULT_PARALLEL_SESSIONS_CONFIG, ...config };
    this.backend = backend ?? null;

    if (this.config.enabled) {
      this.startIdleCheck();
    }
  }

  /**
   * Get or create a session for a given routing context
   */
  async getOrCreateSession(params: {
    channelId: string;
    chatId?: string;
    peerId?: string;
    agentId?: string;
  }): Promise<{ sessionKey: string; isNew: boolean; briefing: string }> {
    const sessionKey = this.buildSessionKey(params);

    const existing = this.sessions.get(sessionKey);
    if (existing) {
      // Reactivate if hibernated — restore from backend
      if (existing.status === "hibernated") {
        // Enforce concurrent limit before reactivating
        await this.enforceSessionLimit();
        await this.resumeSession(sessionKey);
        existing.status = "active";
        this.emit("session:reactivated", existing);
      }
      existing.lastActivityAt = Date.now();

      const briefing = await this.generateBriefing(sessionKey);
      return { sessionKey, isNew: false, briefing };
    }

    // Enforce concurrent limit before creating new session
    await this.enforceSessionLimit();

    // Create new session
    const newSession: SessionState = {
      sessionKey,
      channelId: params.channelId,
      chatId: params.chatId,
      peerId: params.peerId,
      status: "active",
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      messageCount: 0,
    };

    this.sessions.set(sessionKey, newSession);
    this.emit("session:created", newSession);

    const briefing = await this.generateBriefing(sessionKey);
    return { sessionKey, isNew: true, briefing };
  }

  /**
   * Build session key based on isolation level
   */
  private buildSessionKey(params: {
    channelId: string;
    chatId?: string;
    peerId?: string;
    agentId?: string;
  }): string {
    const agentId = params.agentId || "main";
    const channel = params.channelId.toLowerCase();

    switch (this.config.isolation) {
      case "per-chat": {
        const chatId = (params.chatId || params.peerId || "default").toLowerCase();
        return `agent:${agentId}:parallel:${channel}:${chatId}`;
      }

      case "per-peer": {
        const peerId = (params.peerId || "default").toLowerCase();
        return `agent:${agentId}:parallel:peer:${peerId}`;
      }

      case "per-channel":
      default:
        return `agent:${agentId}:parallel:${channel}`;
    }
  }

  /**
   * Generate context briefing for a session.
   * Queries SQLite directly — no in-memory arrays.
   */
  async generateBriefing(sessionKey: string): Promise<string> {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return "";
    }

    const lines: string[] = [];
    const maxChannel = this.config.briefing.maxChannelMemories;
    const maxGlobal = this.config.briefing.maxGlobalKnowledge;
    const minImportance = this.config.briefing.minImportance;
    const minConfidence = this.config.briefing.minConfidence;

    // Query channel memories from SQLite instead of in-memory array
    if (this.backend) {
      const channelMemories = await this.backend.getChannelMemories({
        channelId: session.channelId,
        minImportance,
        excludeExpired: true,
        limit: maxChannel,
      });

      if (channelMemories.length > 0) {
        lines.push("## Channel Context");
        for (const mem of channelMemories) {
          lines.push(`- [${mem.memoryType}] ${mem.content}`);
        }
      }

      const globalEntries = await this.backend.getGlobalKnowledge({
        minConfidence,
        limit: maxGlobal,
      });

      if (globalEntries.length > 0) {
        lines.push("\n## Global Knowledge");
        for (const entry of globalEntries) {
          lines.push(`- [${entry.category}] ${entry.content}`);
        }
      }

      // Include active work items in briefing
      const activeWork = await this.backend.getWorkItems({
        sessionKey,
        statuses: ["scheduled", "ready", "executing"],
        limit: 5,
      });

      if (activeWork.length > 0) {
        lines.push("\n## Active Work");
        for (const item of activeWork) {
          const status =
            item.status === "executing"
              ? `RUNNING (${item.progressPct ?? 0}%)`
              : item.status.toUpperCase();
          lines.push(`- [${status}] ${item.description}`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Save memory entry for a session.
   * Persists directly to SQLite — no in-memory copy.
   */
  async saveMemory(
    entry: Omit<SessionMemoryEntry, "id" | "createdAt" | "promotedToGlobal">,
  ): Promise<void> {
    const memoryEntry: SessionMemoryEntry = {
      ...entry,
      createdAt: Date.now(),
      promotedToGlobal: false,
    };

    // Persist directly to SQLite — no in-memory copy
    if (this.backend) {
      await this.backend.saveChannelMemory(memoryEntry);
    }

    this.emit("memory:saved", memoryEntry);

    // Auto-promote high-importance entries to global knowledge
    if (entry.importance >= this.config.memory.autoPromoteThreshold) {
      await this.promoteToGlobal(memoryEntry);
    }
  }

  /**
   * Promote a memory entry to global knowledge.
   * Persists directly to SQLite — no in-memory copy.
   */
  async promoteToGlobal(entry: SessionMemoryEntry): Promise<void> {
    const globalEntry: GlobalKnowledgeEntry = {
      category: entry.memoryType,
      content: entry.content,
      sourceChannel: entry.channelId,
      sourceSessionKey: entry.sessionKey,
      confidence: entry.importance / 10,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Persist directly to SQLite — no in-memory copy
    if (this.backend) {
      await this.backend.saveGlobalKnowledge(globalEntry);
    }

    entry.promotedToGlobal = true;
    this.emit("knowledge:promoted", globalEntry);
  }

  /**
   * Search across all memories.
   * Delegates to SQLite backend with type guard filter.
   */
  async searchMemory(
    query: string,
    options?: {
      sessionKey?: string;
      channelId?: string;
      types?: SessionMemoryEntry["memoryType"][];
      limit?: number;
    },
  ): Promise<SessionMemoryEntry[]> {
    if (!this.backend) {
      return [];
    }

    const results = await this.backend.searchMemories(query, {
      scope: options?.channelId ? "channel" : "all",
      channelId: options?.channelId,
      limit: options?.limit ?? 10,
    });

    // Filter to SessionMemoryEntry only (they have sessionKey field)
    // This preserves the original API contract — callers expect SessionMemoryEntry[]
    return results.filter((r): r is SessionMemoryEntry => "sessionKey" in r);
  }

  /**
   * Hibernate a session — persist state to backend if available
   */
  async hibernateSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) {
      return;
    }

    session.status = "hibernated";

    if (this.backend) {
      // Persist session state to SQLite
      await this.backend.saveSessionState(session);
    }

    this.emit("session:hibernated", session);
  }

  /**
   * Resume a hibernated session from backend
   */
  private async resumeSession(sessionKey: string): Promise<void> {
    if (!this.backend) {
      return;
    }

    const stored = await this.backend.loadSessionState(sessionKey);
    if (!stored) {
      return;
    }

    // Merge stored state into the in-memory session
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.messageCount = stored.session.messageCount;
    }

    // Clean up the persisted state
    await this.backend.deleteSessionState(sessionKey);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SessionState[] {
    return Array.from(this.sessions.values()).filter((s) => s.status === "active");
  }

  /**
   * Get session statistics.
   * Async — queries SQLite for memory/work counts.
   */
  async getStats(): Promise<{
    totalSessions: number;
    activeSessions: number;
    hibernatedSessions: number;
    totalMemories: number;
    globalKnowledgeCount: number;
    activeWorkItems: number;
  }> {
    const sessions = Array.from(this.sessions.values());
    const backendStats = this.backend ? await this.backend.getStats() : null;

    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === "active").length,
      hibernatedSessions: sessions.filter((s) => s.status === "hibernated").length,
      totalMemories: backendStats?.channelMemoryCount ?? 0,
      globalKnowledgeCount: backendStats?.globalKnowledgeCount ?? 0,
      activeWorkItems: backendStats?.workItemsActive ?? 0,
    };
  }

  // ── Work Management API ──

  /**
   * Schedule a work item for background execution
   */
  async scheduleWork(params: {
    sessionKey: string;
    channelId: string;
    description: string;
    payload: Record<string, unknown>;
    priority?: number;
    scheduledFor?: number;
    maxAttempts?: number;
  }): Promise<number> {
    if (!this.backend) {
      throw new Error("Backend required for work scheduling");
    }

    const status: WorkItem["status"] = params.scheduledFor ? "scheduled" : "ready";
    const id = await this.backend.saveWorkItem({
      sessionKey: params.sessionKey,
      channelId: params.channelId,
      description: params.description,
      payload: params.payload,
      status,
      priority: params.priority ?? 5,
      scheduledFor: params.scheduledFor,
      createdAt: Date.now(),
      attempts: 0,
      maxAttempts: params.maxAttempts ?? 3,
    });

    this.emit("work:scheduled", { id, ...params });
    return id;
  }

  /**
   * Cancel a scheduled or ready work item
   */
  async cancelWork(workId: number): Promise<boolean> {
    if (!this.backend) {
      return false;
    }

    const cancelled = await this.backend.cancelWork(workId);
    if (cancelled) {
      this.emit("work:cancelled", { id: workId });
    }
    return cancelled;
  }

  /**
   * Get work items for a session (for status reporting)
   */
  async getWork(sessionKey: string, statuses?: WorkItem["status"][]): Promise<WorkItem[]> {
    if (!this.backend) {
      return [];
    }

    return this.backend.getWorkItems({
      sessionKey,
      statuses,
    });
  }

  /**
   * Atomically claim work items ready to execute (delegates to backend.claimReadyWork)
   */
  async claimReadyWork(limit: number = 1): Promise<WorkItem[]> {
    if (!this.backend) {
      return [];
    }

    return this.backend.claimReadyWork(limit);
  }

  /**
   * Transition a work item status (used by executor)
   */
  async transitionWork(
    id: number,
    status: WorkItem["status"],
    update?: Partial<Pick<WorkItem, "progressPct" | "resultSummary" | "attempts">>,
  ): Promise<void> {
    if (!this.backend) {
      return;
    }

    await this.backend.transitionWork(id, status, update);
    this.emit("work:transitioned", { id, status, ...update });
  }

  /**
   * Enforce the concurrent session limit by hibernating the oldest active session
   */
  private async enforceSessionLimit(): Promise<void> {
    const activeSessions = Array.from(this.sessions.values()).filter((s) => s.status === "active");
    if (activeSessions.length >= this.config.maxConcurrent) {
      const oldest = activeSessions.toSorted((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
      if (oldest) {
        await this.hibernateSession(oldest.sessionKey);
      }
    }
  }

  /**
   * Start idle session check interval
   */
  private startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
      try {
        const now = Date.now();
        for (const session of this.sessions.values()) {
          if (
            session.status === "active" &&
            now - session.lastActivityAt > this.config.idleTimeoutMs
          ) {
            session.status = "idle";
            this.emit("session:idle", session);
          }
        }
      } catch {
        // Swallow errors in background timer to avoid crashing the process
      }
    }, 60_000); // Check every minute
  }

  // evictIfNeeded() and evictGlobalIfNeeded() REMOVED — SQLite handles all storage

  /**
   * Cleanup and shutdown
   */
  async shutdown(): Promise<void> {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
    }

    // Hibernate all active sessions
    for (const session of this.sessions.values()) {
      if (session.status === "active") {
        await this.hibernateSession(session.sessionKey);
      }
    }

    this.emit("shutdown");
  }
}

export function createParallelSessionManager(
  config?: Partial<ParallelSessionsConfig>,
  backend?: SharedMemoryBackend,
): ParallelSessionManager {
  return new ParallelSessionManager(config, backend);
}
