/**
 * OpenClaw AGI - Nexus (Orchestration Layer)
 *
 * The Nexus is the single entry point for AGI subsystems. It initializes,
 * coordinates, and exposes all modules (kernel, memory, intent, episodic,
 * graph, learning, proactive) through a unified API.
 *
 * Lifecycle:
 *   1. Call `createNexus(agentId)` to spin up all modules
 *   2. Call `nexus.startSession()` at the beginning of each agent turn
 *   3. Use the module accessors during the turn
 *   4. Call `nexus.endSession()` when the turn completes
 *   5. Call `nexus.shutdown()` for graceful teardown
 *
 * Uses the shared DatabaseManager — all modules share one SQLite connection.
 *
 * @module agi/nexus
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  EpisodicMemoryManager,
  type EpisodicSession,
  type EmbedFn,
  type SessionOutcome,
} from "../episodic/index.js";
import {
  GraphMemoryManager,
  type GraphEntity,
  type EntityType,
  type RelationType,
} from "../graph/index.js";
import {
  IntentEngine,
  type Intent,
  type IntentType,
  type IntentPriority,
  type IntentMetrics,
} from "../intent/index.js";
// Module imports
import {
  AgentKernelManager,
  type AgentKernel,
  type AgentMode,
  type PersonalityProfile,
} from "../kernel/index.js";
import { LearningManager, type LearnedPattern, type FeedbackEvent } from "../learning/index.js";
import { WorkingMemoryManager, type WorkingMemoryState } from "../memory/index.js";
import {
  ProactiveManager,
  type ProactiveRule,
  type TriggerEvent,
  type FiredAction,
} from "../proactive/index.js";
import { DatabaseManager } from "../shared/db.js";

const log = createSubsystemLogger("agi:nexus");

// ============================================================================
// TYPES
// ============================================================================

export interface NexusConfig {
  agentId: string;
  agentName?: string;
  personality?: Partial<PersonalityProfile>;
  embedFn?: EmbedFn;
  autoSaveSeconds?: number;
  dbPath?: string;
}

export interface NexusSession {
  sessionId: string;
  episodicSessionId: string;
  isNewKernelSession: boolean;
  startedAt: Date;
}

export interface NexusStats {
  kernel: { sessions: number; mode: AgentMode };
  memory: { filesOpen: number; toolsUsed: number; decisions: number };
  intents: IntentMetrics;
  episodic: { sessions: number; episodes: number; events: number };
  graph: { entities: number; relations: number };
  learning: { patterns: number; corrections: number; preferences: number };
  proactive: { rules: number; firings: number };
}

export interface ContextSnapshot {
  mode: AgentMode;
  activeIntent?: string;
  currentStep?: string;
  recentFiles: string[];
  recentTools: string[];
  relevantPatterns: string[];
  recentCorrections: string[];
}

// ============================================================================
// NEXUS
// ============================================================================

export class Nexus {
  private agentId: string;
  private config: NexusConfig;
  private currentSession?: NexusSession;

  // Module instances (lazy-initialized, shared DB)
  readonly kernel: AgentKernelManager;
  readonly memory: WorkingMemoryManager;
  readonly intents: IntentEngine;
  readonly episodic: EpisodicMemoryManager;
  readonly graph: GraphMemoryManager;
  readonly learning: LearningManager;
  readonly proactive: ProactiveManager;

  constructor(config: NexusConfig) {
    this.agentId = config.agentId;
    this.config = config;

    // Initialize all modules — they all share one DatabaseSync via DatabaseManager
    this.kernel = new AgentKernelManager(config.agentId, config.dbPath);
    this.memory = new WorkingMemoryManager(config.agentId, undefined, config.dbPath);
    this.intents = new IntentEngine(config.agentId, config.dbPath);
    this.episodic = new EpisodicMemoryManager(config.agentId, config.embedFn, config.dbPath);
    this.graph = new GraphMemoryManager(config.agentId, config.dbPath);
    this.learning = new LearningManager(config.agentId, config.dbPath);
    this.proactive = new ProactiveManager(config.agentId, config.dbPath);

    // Ensure agent identity exists
    this.ensureIdentity(config);

    log.info(`Nexus initialized for agent: ${config.agentId}`);
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  /**
   * Start a new agent session.
   *
   * This:
   * 1. Touches the kernel (updates lastActiveAt)
   * 2. Starts a new working memory session
   * 3. Starts a new episodic session
   * 4. Enables auto-save on working memory
   * 5. Fires a `session_start` trigger for proactive rules
   */
  async startSession(intent?: string): Promise<NexusSession> {
    // Kernel: detect new session (>5 min gap)
    const identity = this.kernel.loadIdentity();
    const isNewSession = identity
      ? identity.lastActiveAt.getTime() < Date.now() - 5 * 60 * 1000
      : true;

    if (isNewSession && identity) {
      this.kernel.incrementSessions();
    }
    this.kernel.touch();
    this.kernel.setUserPresence("online");

    // Working memory: try to restore or start fresh
    const latestSessionId = this.memory.getLatestSession();
    let memoryState: WorkingMemoryState;
    if (latestSessionId && !isNewSession) {
      const restored = this.memory.restoreSession(latestSessionId);
      memoryState = restored || this.memory.startSession();
    } else {
      memoryState = this.memory.startSession();
    }
    this.memory.enableAutoSave(this.config.autoSaveSeconds || 30);

    // Episodic: start recording
    const episodicSession = this.episodic.startSession(intent);

    const session: NexusSession = {
      sessionId: memoryState.sessionId,
      episodicSessionId: episodicSession.id,
      isNewKernelSession: isNewSession,
      startedAt: new Date(),
    };
    this.currentSession = session;

    // Fire proactive trigger
    await this.proactive
      .evaluate({
        type: "session_start",
        data: { isNew: isNewSession, intent: intent || "" },
        timestamp: new Date(),
      })
      .catch((err) => {
        log.warn(`Proactive session_start trigger failed: ${String(err)}`);
      });

    log.info(`Session started: ${session.sessionId} (new kernel session: ${isNewSession})`);
    return session;
  }

  /**
   * End the current session.
   *
   * Saves working memory, finalizes the episodic session,
   * and auto-chunks events into episodes.
   */
  async endSession(outcome: SessionOutcome = "success", summary?: string): Promise<void> {
    if (!this.currentSession) {
      log.warn("endSession called with no active session");
      return;
    }

    // Save working memory
    this.memory.save();
    this.memory.disableAutoSave();

    // End episodic session
    await this.episodic.endSession(this.currentSession.episodicSessionId, outcome, summary);

    // Auto-chunk events into episodes
    await this.episodic.autoChunkSession(this.currentSession.episodicSessionId).catch((err) => {
      log.warn(`Episode auto-chunking failed: ${String(err)}`);
    });

    // Update kernel mode to idle
    this.kernel.setMode("idle");
    this.kernel.setUserPresence("away");

    // Fire proactive trigger
    await this.proactive
      .evaluate({
        type: "session_end",
        data: { outcome, sessionId: this.currentSession.sessionId },
        timestamp: new Date(),
      })
      .catch((err) => {
        log.warn(`Proactive session_end trigger failed: ${String(err)}`);
      });

    log.info(`Session ended: ${this.currentSession.sessionId} (${outcome})`);
    this.currentSession = undefined;
  }

  /** Graceful shutdown of all AGI subsystems */
  shutdown(): void {
    this.memory.close();
    DatabaseManager.close(this.agentId);
    log.info(`Nexus shutdown for agent: ${this.agentId}`);
  }

  // ============================================================================
  // CONTEXT GENERATION
  // ============================================================================

  /**
   * Generate a context snapshot for the system prompt.
   *
   * This is the key integration point: the Nexus collects relevant
   * context from all modules and formats it for injection into
   * the agent's system prompt.
   */
  getContextSnapshot(currentContext?: string): ContextSnapshot {
    const state = this.kernel.loadState();
    const mem = this.memory.getMemory();

    // Get recent files (paths only, not content)
    const recentFiles = this.memory.getRecentFiles(5).map((f) => f.path);

    // Get recent tools
    const recentTools = this.memory
      .getRecentTools(5)
      .map((t) => `${t.tool}(${Object.keys(t.params).join(",")})`);

    // Get relevant learned patterns
    const relevantPatterns = currentContext
      ? this.learning.getRelevantPatterns(currentContext, 3).map((p) => p.pattern)
      : [];

    // Get recent corrections
    const recentCorrections = this.learning
      .getCorrections(currentContext, 3)
      .map((c) => `"${c.mistake}" → "${c.correction}"`);

    return {
      mode: state?.mode || "idle",
      activeIntent: mem.intent?.description,
      currentStep: mem.progress?.currentStep,
      recentFiles,
      recentTools,
      relevantPatterns,
      recentCorrections,
    };
  }

  /**
   * Format context as a string block for system prompt injection.
   *
   * Returns an empty string if there's nothing meaningful to inject.
   */
  formatContextForPrompt(currentContext?: string): string {
    const snapshot = this.getContextSnapshot(currentContext);
    const lines: string[] = [];

    lines.push(`[AGI Context]`);
    lines.push(`Mode: ${snapshot.mode}`);

    if (snapshot.activeIntent) {
      lines.push(`Active intent: ${snapshot.activeIntent}`);
    }
    if (snapshot.currentStep) {
      lines.push(`Current step: ${snapshot.currentStep}`);
    }
    if (snapshot.recentFiles.length > 0) {
      lines.push(`Recent files: ${snapshot.recentFiles.join(", ")}`);
    }
    if (snapshot.relevantPatterns.length > 0) {
      lines.push(`Learned patterns: ${snapshot.relevantPatterns.join("; ")}`);
    }
    if (snapshot.recentCorrections.length > 0) {
      lines.push(`Recent corrections: ${snapshot.recentCorrections.join("; ")}`);
    }

    // Only return if we have meaningful context beyond just mode
    if (lines.length <= 2) {
      return "";
    }
    return lines.join("\n");
  }

  // ============================================================================
  // CONVENIENCE WRAPPERS
  // ============================================================================

  /** Record a user message event in episodic memory */
  recordUserMessage(content: string): void {
    if (!this.currentSession) {
      return;
    }
    this.episodic.recordEvent(this.currentSession.episodicSessionId, "user_message", content);
  }

  /** Record an agent response in episodic memory */
  recordAgentResponse(content: string): void {
    if (!this.currentSession) {
      return;
    }
    this.episodic.recordEvent(this.currentSession.episodicSessionId, "agent_message", content);
  }

  /** Record a tool call in both working and episodic memory */
  recordToolCall(
    tool: string,
    params: Record<string, unknown>,
    result: unknown,
    duration: number,
  ): void {
    this.memory.recordTool(tool, params, result, duration);
    if (this.currentSession) {
      this.episodic.recordEvent(
        this.currentSession.episodicSessionId,
        "tool_call",
        `${tool}(${JSON.stringify(params).slice(0, 200)})`,
        { tool, duration },
      );
    }
  }

  /** Record a decision in working memory + episodic */
  recordDecision(context: string, what: string, why: string, alternatives?: string[]): void {
    this.memory.recordDecision(context, what, why, alternatives);
    if (this.currentSession) {
      this.episodic.recordEvent(
        this.currentSession.episodicSessionId,
        "decision",
        `${what}: ${why}`,
        { alternatives },
      );
    }
  }

  /** Record a file access in working memory */
  recordFileAccess(filePath: string, content?: string): void {
    this.memory.recordFile(filePath, content);
  }

  /** Process user feedback (positive/negative/correction) */
  processFeedback(feedback: FeedbackEvent): void {
    this.learning.processFeedback(feedback);
  }

  /** Search past episodes semantically */
  async searchMemory(
    query: string,
    limit = 5,
  ): Promise<Array<{ summary: string; score: number; when: Date }>> {
    const results = await this.episodic.searchEpisodes(query, limit);
    return results.map((r) => ({
      summary: r.episode.summary,
      score: r.score,
      when: r.episode.startTime,
    }));
  }

  /** Fire a trigger event for proactive rules */
  async fireTrigger(event: TriggerEvent): Promise<FiredAction[]> {
    return this.proactive.evaluate(event);
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  getStats(): NexusStats {
    const kernel = this.kernel.getKernel();
    const mem = this.memory.getMemory();
    const intentMetrics = this.intents.getMetrics();
    const episodicStats = this.episodic.getStats();
    const graphStats = this.graph.getStats();
    const learningStats = this.learning.getStats();
    const proactiveStats = this.proactive.getStats();

    return {
      kernel: {
        sessions: kernel?.identity.totalSessions || 0,
        mode: kernel?.state.mode || "idle",
      },
      memory: {
        filesOpen: mem.filesOpen.size,
        toolsUsed: mem.toolsUsed.length,
        decisions: mem.decisions.length,
      },
      intents: intentMetrics,
      episodic: {
        sessions: episodicStats.totalSessions,
        episodes: episodicStats.totalEpisodes,
        events: episodicStats.totalEvents,
      },
      graph: {
        entities: graphStats.totalEntities,
        relations: graphStats.totalRelations,
      },
      learning: {
        patterns: learningStats.totalPatterns,
        corrections: learningStats.totalCorrections,
        preferences: learningStats.totalPreferences,
      },
      proactive: {
        rules: proactiveStats.totalRules,
        firings: proactiveStats.totalFirings,
      },
    };
  }

  // ============================================================================
  // ACCESSORS
  // ============================================================================

  getAgentId(): string {
    return this.agentId;
  }

  getCurrentSession(): NexusSession | undefined {
    return this.currentSession;
  }

  isSessionActive(): boolean {
    return this.currentSession !== undefined;
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private ensureIdentity(config: NexusConfig): void {
    const identity = this.kernel.loadIdentity();
    if (!identity) {
      this.kernel.createIdentity({
        name: config.agentName || config.agentId,
        description: `OpenClaw AGI agent: ${config.agentId}`,
        personality: config.personality,
      });
      this.kernel.initializeState();
      log.info(`Created new agent identity: ${config.agentId}`);
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

const nexusInstances = new Map<string, Nexus>();

/**
 * Create or retrieve a Nexus instance for the given agent.
 *
 * This is the primary entry point for the AGI subsystem.
 * Call this once per agent, then use the returned Nexus for the entire lifetime.
 */
export function createNexus(config: NexusConfig): Nexus {
  if (nexusInstances.has(config.agentId)) {
    return nexusInstances.get(config.agentId)!;
  }

  const nexus = new Nexus(config);
  nexusInstances.set(config.agentId, nexus);
  return nexus;
}

export function getNexus(agentId: string): Nexus | undefined {
  return nexusInstances.get(agentId);
}

export function shutdownAllNexus(): void {
  for (const [, nexus] of nexusInstances) {
    nexus.shutdown();
  }
  nexusInstances.clear();
  log.info("All Nexus instances shut down");
}

// Re-export key types for convenience
export type {
  AgentKernel,
  AgentMode,
  PersonalityProfile,
  WorkingMemoryState,
  Intent,
  IntentType,
  IntentPriority,
  IntentMetrics,
  EpisodicSession,
  SessionOutcome,
  GraphEntity,
  EntityType,
  RelationType,
  LearnedPattern,
  FeedbackEvent,
  ProactiveRule,
  TriggerEvent,
  FiredAction,
  EmbedFn,
};
