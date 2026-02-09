/**
 * OpenClaw AGI - Barrel Export
 *
 * Single entry point for all AGI modules.
 *
 * Usage:
 * ```ts
 * import { createNexus, getVoyageClient, createEmbedFn } from "../agi/index.js";
 *
 * const embedFn = createEmbedFn();
 * const nexus = createNexus({ agentId: "agent-1", embedFn });
 * await nexus.startSession("implement feature");
 * ```
 *
 * @module agi
 */

// Nexus (primary orchestration layer)
export {
  Nexus,
  createNexus,
  getNexus,
  shutdownAllNexus,
  type NexusConfig,
  type NexusSession,
  type NexusStats,
  type ContextSnapshot,
} from "./nexus/index.js";

// Kernel
export {
  AgentKernelManager,
  getAgentKernel,
  createAgentKernel,
  loadAgentKernel,
  resumeAgentSession,
  type AgentKernel,
  type AgentIdentity,
  type AgentState,
  type AgentMode,
  type PersonalityProfile,
  type AttentionFocus,
  type CodebaseSnapshot,
} from "./kernel/index.js";

// Working Memory
export {
  WorkingMemoryManager,
  getWorkingMemory,
  startWorkingMemorySession,
  restoreWorkingMemorySession,
  type WorkingMemoryState,
  type FileContext,
  type ToolInvocation,
  type Decision,
  type Thought,
  type Note,
  type Reminder,
  type ActiveIntent,
  type ExecutionPlan,
  type PlanStep as MemoryPlanStep,
  type Progress,
} from "./memory/index.js";

// Intent Engine
export {
  IntentEngine,
  getIntentEngine,
  type Intent,
  type IntentType,
  type IntentPriority,
  type IntentStatus,
  type Plan,
  type PlanStep,
  type PlanStatus,
  type StepStatus,
  type Checkpoint,
  type IntentMetrics,
} from "./intent/index.js";

// Episodic Memory
export {
  EpisodicMemoryManager,
  getEpisodicMemory,
  type EpisodicSession,
  type SessionEvent,
  type Episode,
  type SessionOutcome,
  type EventType,
  type EmbedFn,
  type EpisodeSearchResult,
  type SessionSearchResult,
} from "./episodic/index.js";

// Graph Memory
export {
  GraphMemoryManager,
  getGraphMemory,
  type GraphEntity,
  type GraphRelation,
  type EntityType,
  type RelationType,
  type PathResult,
  type NeighborhoodResult,
} from "./graph/index.js";

// Learning
export {
  LearningManager,
  getLearningManager,
  type LearnedPattern,
  type Correction,
  type Preference,
  type FeedbackEvent,
  type FeedbackType,
} from "./learning/index.js";

// Proactive
export {
  ProactiveManager,
  getProactiveManager,
  type ProactiveRule,
  type TriggerEvent,
  type FiredAction,
  type TriggerType,
  type ActionType,
  type RulePriority,
  type ProactiveLogEntry,
} from "./proactive/index.js";

// Vector / Embeddings
export {
  VoyageEmbeddingClient,
  getVoyageClient,
  createEmbedFn,
  cosineSimilarity,
  VoyageError,
  type VoyageConfig,
} from "./vector/index.js";

// Shared infrastructure
export {
  DatabaseManager,
  getDatabase,
  resolveAgiDbPath,
  jsonToSql,
  sqlToJson,
  dateToSql,
  sqlToDate,
  booleanToSql,
  sqlToBoolean,
} from "./shared/db.js";

export {
  AGIError,
  AgentNotFoundError,
  DatabaseError,
  ValidationError,
  wrapError,
  errorHandler,
} from "./shared/errors.js";

export {
  generateId,
  generateShortId,
  computeChecksum,
  computeHash,
  now,
  nowISO,
  isExpired,
  formatDuration,
  withRetry,
  sleep,
  measureTimeAsync,
} from "./shared/utils.js";
