/**
 * Configuration schema for parallel sessions
 *
 * @untested - This is a proof-of-concept implementation
 */

import { z } from "zod";

/**
 * Session isolation level:
 * - "main": All messages share one session (current default)
 * - "per-channel": Each channel (whatsapp, telegram, etc.) gets its own session
 * - "per-chat": Each chat/conversation gets its own session
 * - "per-peer": Each unique peer (person) gets their own session across channels
 */
export const SessionIsolationLevel = z.enum(["main", "per-channel", "per-chat", "per-peer"]);
export type SessionIsolationLevel = z.infer<typeof SessionIsolationLevel>;

/**
 * Memory backend type:
 * - "memory": In-memory only (lost on restart)
 * - "sqlite": SQLite-based persistent storage
 * - "lancedb": LanceDB vector store (for semantic search)
 */
export const MemoryBackendType = z.enum(["memory", "sqlite", "lancedb"]);
export type MemoryBackendType = z.infer<typeof MemoryBackendType>;

/**
 * Parallel sessions configuration schema
 */
export const ParallelSessionsConfigSchema = z.object({
  /**
   * Enable parallel session mode
   * When true, messages from different channels/chats can be processed
   * with separate context while sharing a common knowledge base
   */
  enabled: z.boolean().default(false),

  /**
   * Session isolation level
   */
  isolation: SessionIsolationLevel.default("per-channel"),

  /**
   * Maximum number of concurrent active sessions
   * Older idle sessions will be hibernated when limit is reached
   */
  maxConcurrent: z.number().int().min(1).max(50).default(5),

  /**
   * Idle timeout in milliseconds before session hibernation
   * Default: 5 minutes
   */
  idleTimeoutMs: z.number().int().min(10000).default(300000),

  /**
   * Memory backend configuration
   */
  memory: z.object({
    /**
     * Backend type for shared memory
     */
    backend: MemoryBackendType.default("sqlite"),

    /**
     * Path to the memory database
     * Default: ~/.clawdbot/data/shared-memory.db
     */
    dbPath: z.string().optional(),

    /**
     * Enable WAL mode for SQLite (better concurrent access)
     */
    enableWAL: z.boolean().default(true),

    /**
     * Auto-promote memories with importance >= this value to global knowledge
     */
    autoPromoteThreshold: z.number().int().min(1).max(10).default(8),

    /**
     * Default TTL for memories in milliseconds (0 = no expiration)
     */
    defaultTTLMs: z.number().int().min(0).default(0),
  }).default({}),

  /**
   * Briefing configuration
   */
  briefing: z.object({
    /**
     * Always inject context briefing before processing messages
     */
    enabled: z.boolean().default(true),

    /**
     * Maximum number of channel memories to include
     */
    maxChannelMemories: z.number().int().min(0).max(50).default(10),

    /**
     * Maximum number of global knowledge entries to include
     */
    maxGlobalKnowledge: z.number().int().min(0).max(20).default(5),

    /**
     * Minimum importance for memories to be included
     */
    minImportance: z.number().int().min(1).max(10).default(5),

    /**
     * Minimum confidence for global knowledge to be included
     */
    minConfidence: z.number().min(0).max(1).default(0.7),
  }).default({}),

  /**
   * Auto-save configuration
   */
  autoSave: z.object({
    /**
     * Automatically save summaries after conversations
     */
    summaries: z.boolean().default(true),

    /**
     * Automatically detect and save decisions
     */
    decisions: z.boolean().default(true),

    /**
     * Automatically detect and save preferences
     */
    preferences: z.boolean().default(true),

    /**
     * Automatically track action items
     */
    actionItems: z.boolean().default(true),
  }).default({}),
});

export type ParallelSessionsConfig = z.infer<typeof ParallelSessionsConfigSchema>;

/**
 * Default configuration
 */
export const DEFAULT_PARALLEL_SESSIONS_CONFIG: ParallelSessionsConfig = {
  enabled: false,
  isolation: "per-channel",
  maxConcurrent: 5,
  idleTimeoutMs: 300000,
  memory: {
    backend: "sqlite",
    enableWAL: true,
    autoPromoteThreshold: 8,
    defaultTTLMs: 0,
  },
  briefing: {
    enabled: true,
    maxChannelMemories: 10,
    maxGlobalKnowledge: 5,
    minImportance: 5,
    minConfidence: 0.7,
  },
  autoSave: {
    summaries: true,
    decisions: true,
    preferences: true,
    actionItems: true,
  },
};

/**
 * Example YAML configuration
 */
export const EXAMPLE_CONFIG_YAML = `
# Parallel Sessions Configuration
#
# Enable concurrent sessions with shared memory
# Each channel/chat gets isolated context while sharing knowledge

agent:
  parallelSessions:
    # Enable parallel session mode
    enabled: true
    
    # Session isolation level:
    # - main: All messages share one session (default)
    # - per-channel: Each channel gets its own session
    # - per-chat: Each conversation gets its own session  
    # - per-peer: Each person gets their own session
    isolation: per-channel
    
    # Maximum concurrent active sessions
    maxConcurrent: 5
    
    # Idle timeout before hibernation (5 minutes)
    idleTimeoutMs: 300000
    
    # Shared memory configuration
    memory:
      backend: sqlite
      # dbPath: ~/.clawdbot/data/shared-memory.db
      enableWAL: true
      autoPromoteThreshold: 8
    
    # Context briefing before each message
    briefing:
      enabled: true
      maxChannelMemories: 10
      maxGlobalKnowledge: 5
      minImportance: 5
    
    # Auto-save learned context
    autoSave:
      summaries: true
      decisions: true
      preferences: true
      actionItems: true
`;
