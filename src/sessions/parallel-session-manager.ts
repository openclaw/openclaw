/**
 * Parallel Session Manager
 *
 * Manages concurrent agent sessions with shared memory backend.
 * Each channel/chat can have its own isolated session context while
 * sharing a common knowledge base.
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

/** Maximum in-memory session memories before eviction */
const MAX_SESSION_MEMORIES = 500;

/** Maximum in-memory global knowledge before eviction */
const MAX_GLOBAL_KNOWLEDGE = 100;

/**
 * Manages parallel agent sessions with shared memory
 */
export class ParallelSessionManager extends EventEmitter {
  private config: ParallelSessionsConfig;
  private sessions: Map<string, SessionState> = new Map();
  private sessionMemory: SessionMemoryEntry[] = [];
  private globalKnowledge: GlobalKnowledgeEntry[] = [];
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
   * Generate context briefing for a session
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

    // Get channel-specific memories
    const channelMemories = this.sessionMemory
      .filter((m) => m.sessionKey === sessionKey || m.channelId === session.channelId)
      .filter((m) => !m.expiresAt || m.expiresAt > Date.now())
      .filter((m) => m.importance >= minImportance)
      .toSorted((a, b) => b.importance - a.importance)
      .slice(0, maxChannel);

    if (channelMemories.length > 0) {
      lines.push("## Channel Context");
      for (const mem of channelMemories) {
        lines.push(`- [${mem.memoryType}] ${mem.content}`);
      }
    }

    // Get relevant global knowledge
    const globalEntries = this.globalKnowledge
      .filter((g) => g.confidence >= minConfidence)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxGlobal);

    if (globalEntries.length > 0) {
      lines.push("\n## Global Knowledge");
      for (const entry of globalEntries) {
        lines.push(`- [${entry.category}] ${entry.content}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Save memory entry for a session
   */
  async saveMemory(
    entry: Omit<SessionMemoryEntry, "id" | "createdAt" | "promotedToGlobal">,
  ): Promise<void> {
    const memoryEntry: SessionMemoryEntry = {
      ...entry,
      createdAt: Date.now(),
      promotedToGlobal: false,
    };

    this.sessionMemory.push(memoryEntry);
    this.evictIfNeeded();
    this.emit("memory:saved", memoryEntry);

    // Persist to backend if available
    if (this.backend) {
      await this.backend.saveChannelMemory(memoryEntry);
    }

    // Auto-promote high-importance entries to global knowledge
    if (entry.importance >= this.config.memory.autoPromoteThreshold) {
      await this.promoteToGlobal(memoryEntry);
    }
  }

  /**
   * Promote a memory entry to global knowledge
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

    this.globalKnowledge.push(globalEntry);
    this.evictGlobalIfNeeded();
    entry.promotedToGlobal = true;
    this.emit("knowledge:promoted", globalEntry);

    // Persist to backend if available
    if (this.backend) {
      await this.backend.saveGlobalKnowledge(globalEntry);
    }
  }

  /**
   * Search across all memories
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
    const lowerQuery = query.toLowerCase();
    const limit = options?.limit ?? 10;

    return this.sessionMemory
      .filter((m) => {
        if (options?.sessionKey && m.sessionKey !== options.sessionKey) {
          return false;
        }
        if (options?.channelId && m.channelId !== options.channelId) {
          return false;
        }
        if (options?.types && !options.types.includes(m.memoryType)) {
          return false;
        }
        if (m.expiresAt && m.expiresAt < Date.now()) {
          return false;
        }
        return m.content.toLowerCase().includes(lowerQuery);
      })
      .toSorted((a, b) => b.importance - a.importance)
      .slice(0, limit);
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
   * Get session statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    hibernatedSessions: number;
    totalMemories: number;
    globalKnowledgeCount: number;
  } {
    const sessions = Array.from(this.sessions.values());
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === "active").length,
      hibernatedSessions: sessions.filter((s) => s.status === "hibernated").length,
      totalMemories: this.sessionMemory.length,
      globalKnowledgeCount: this.globalKnowledge.length,
    };
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

  /**
   * Evict lowest-importance session memories when array exceeds limit
   */
  private evictIfNeeded(): void {
    if (this.sessionMemory.length > MAX_SESSION_MEMORIES) {
      // Sort by importance ascending (lowest first) then by age (oldest first)
      this.sessionMemory.sort((a, b) => a.importance - b.importance || a.createdAt - b.createdAt);
      // Remove the excess from the front (lowest importance / oldest)
      this.sessionMemory.splice(0, this.sessionMemory.length - MAX_SESSION_MEMORIES);
    }
  }

  /**
   * Evict lowest-confidence global knowledge when array exceeds limit
   */
  private evictGlobalIfNeeded(): void {
    if (this.globalKnowledge.length > MAX_GLOBAL_KNOWLEDGE) {
      this.globalKnowledge.sort((a, b) => a.confidence - b.confidence || a.updatedAt - b.updatedAt);
      this.globalKnowledge.splice(0, this.globalKnowledge.length - MAX_GLOBAL_KNOWLEDGE);
    }
  }

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
