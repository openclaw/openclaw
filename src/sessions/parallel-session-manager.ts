/**
 * Parallel Session Manager
 *
 * Manages concurrent agent sessions with shared memory backend.
 * Each channel/chat can have its own isolated session context while
 * sharing a common knowledge base.
 *
 * @untested - This is a proof-of-concept implementation
 */

import { EventEmitter } from "node:events";

export interface ParallelSessionConfig {
  /** Enable parallel session mode */
  enabled: boolean;
  /** Maximum concurrent sessions */
  maxConcurrent: number;
  /** Session isolation level */
  isolation: "per-channel" | "per-chat" | "per-peer";
  /** Idle timeout before session hibernation (ms) */
  idleTimeoutMs: number;
  /** Memory backend type */
  memoryBackend: "sqlite" | "memory" | "lancedb";
  /** Path to shared memory database */
  memoryDbPath?: string;
}

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

const DEFAULT_CONFIG: ParallelSessionConfig = {
  enabled: false,
  maxConcurrent: 5,
  isolation: "per-channel",
  idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
  memoryBackend: "sqlite",
};

/**
 * Manages parallel agent sessions with shared memory
 */
export class ParallelSessionManager extends EventEmitter {
  private config: ParallelSessionConfig;
  private sessions: Map<string, SessionState> = new Map();
  private sessionMemory: SessionMemoryEntry[] = [];
  private globalKnowledge: GlobalKnowledgeEntry[] = [];
  private idleCheckInterval?: ReturnType<typeof setInterval>;

  constructor(config: Partial<ParallelSessionConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

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
      // Reactivate if hibernated
      if (existing.status === "hibernated") {
        existing.status = "active";
        this.emit("session:reactivated", existing);
      }
      existing.lastActivityAt = Date.now();

      const briefing = await this.generateBriefing(sessionKey);
      return { sessionKey, isNew: false, briefing };
    }

    // Check concurrent session limit
    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.status === "active"
    );
    if (activeSessions.length >= this.config.maxConcurrent) {
      // Hibernate oldest idle session
      const oldest = activeSessions
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
      if (oldest) {
        await this.hibernateSession(oldest.sessionKey);
      }
    }

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
      case "per-chat":
        const chatId = (params.chatId || params.peerId || "default").toLowerCase();
        return `agent:${agentId}:parallel:${channel}:${chatId}`;

      case "per-peer":
        const peerId = (params.peerId || "default").toLowerCase();
        return `agent:${agentId}:parallel:peer:${peerId}`;

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

    // Get channel-specific memories
    const channelMemories = this.sessionMemory
      .filter((m) => m.sessionKey === sessionKey || m.channelId === session.channelId)
      .filter((m) => !m.expiresAt || m.expiresAt > Date.now())
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);

    if (channelMemories.length > 0) {
      lines.push("## Channel Context");
      for (const mem of channelMemories) {
        lines.push(`- [${mem.memoryType}] ${mem.content}`);
      }
    }

    // Get relevant global knowledge
    const globalEntries = this.globalKnowledge
      .filter((g) => g.confidence >= 0.7)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5);

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
  async saveMemory(entry: Omit<SessionMemoryEntry, "id" | "createdAt" | "promotedToGlobal">): Promise<void> {
    const memoryEntry: SessionMemoryEntry = {
      ...entry,
      createdAt: Date.now(),
      promotedToGlobal: false,
    };

    this.sessionMemory.push(memoryEntry);
    this.emit("memory:saved", memoryEntry);

    // Auto-promote high-importance entries to global knowledge
    if (entry.importance >= 8) {
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
    entry.promotedToGlobal = true;
    this.emit("knowledge:promoted", globalEntry);
  }

  /**
   * Search across all memories
   */
  async searchMemory(query: string, options?: {
    sessionKey?: string;
    channelId?: string;
    types?: SessionMemoryEntry["memoryType"][];
    limit?: number;
  }): Promise<SessionMemoryEntry[]> {
    const lowerQuery = query.toLowerCase();
    const limit = options?.limit ?? 10;

    return this.sessionMemory
      .filter((m) => {
        if (options?.sessionKey && m.sessionKey !== options.sessionKey) return false;
        if (options?.channelId && m.channelId !== options.channelId) return false;
        if (options?.types && !options.types.includes(m.memoryType)) return false;
        if (m.expiresAt && m.expiresAt < Date.now()) return false;
        return m.content.toLowerCase().includes(lowerQuery);
      })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit);
  }

  /**
   * Hibernate a session (serialize context to DB)
   */
  async hibernateSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    session.status = "hibernated";
    this.emit("session:hibernated", session);
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
   * Start idle session check interval
   */
  private startIdleCheck(): void {
    this.idleCheckInterval = setInterval(() => {
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
    }, 60_000); // Check every minute
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
  config?: Partial<ParallelSessionConfig>
): ParallelSessionManager {
  return new ParallelSessionManager(config);
}
