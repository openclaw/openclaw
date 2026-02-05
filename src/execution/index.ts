/**
 * Agent Execution Layer
 *
 * Unified orchestration architecture for agent execution.
 * All agent runs flow through this layer with consistent runtime selection,
 * execution, normalization, event emission, and state persistence.
 *
 * @see docs/design/plans/opus/01-agent-execution-layer.md
 */

// Core types
export type {
  // Event types
  ExecutionEvent,
  ExecutionEventKind,
  EventListener,
  Unsubscribe,
  // Callback types
  OnPartialReplyCallback,
  OnBlockReplyCallback,
  OnBlockReplyFlushCallback,
  OnReasoningStreamCallback,
  OnToolResultCallback,
  OnAssistantMessageStartCallback,
  OnAgentEventCallback,
  OnToolStartCallback,
  OnToolEndCallback,
  OnExecutionEventCallback,
  // Request/Result types
  ExecutionRequest,
  ExecutionResult,
  ExecutionRuntimeInfo,
  MessageContext,
  // Internal types (for layer components)
  TurnOutcome,
  RuntimeContext,
  RuntimeCapabilities,
  ToolPolicy,
  SandboxContext,
  // Metrics and summaries
  UsageMetrics,
  ToolCallSummary,
  // Error types
  ExecutionError,
  ExecutionErrorKind,
  // Config types
  ExecutionConfig,
  ExecutionEntryPointFlags,
} from "./types.js";

// Feature flag utilities
export {
  useNewExecutionLayer,
  anyNewExecutionLayerEnabled,
  getExecutionLayerStatus,
  type ExecutionEntryPoint,
} from "./feature-flag.js";

// Event Router
export {
  EventRouter,
  createEventRouter,
  createLegacyEventAdapter,
  // Hook mapping
  EVENT_TO_HOOK_MAP,
  getHookForEventKind,
  // Event builder helpers
  createEvent,
  createLifecycleStartEvent,
  createLifecycleEndEvent,
  createLifecycleErrorEvent,
  createToolStartEvent,
  createToolEndEvent,
  createAssistantPartialEvent,
  createAssistantCompleteEvent,
  createCompactionStartEvent,
  createCompactionEndEvent,
  createHookTriggeredEvent,
  type EventRouterLogger,
  type EventRouterOptions,
} from "./events.js";

// State Service
export {
  DefaultStateService,
  createStateService,
  hasNonzeroUsageMetrics,
  type StateService,
  type StatePersistOptions,
  type CompactionUpdateResult,
  type CompactionUpdateOptions,
  type StateServiceLogger,
  type StateServiceOptions,
} from "./state.js";

// Runtime Resolver
export {
  DefaultRuntimeResolver,
  createRuntimeResolver,
  type RuntimeResolver,
  type RuntimeResolverLogger,
  type RuntimeResolverOptions,
} from "./resolver.js";

// Normalization Utilities
export {
  // Core normalization functions
  stripHeartbeatTokens,
  stripThinkingTags,
  normalizeWhitespace,
  isSilentReply,
  deduplicateReplies,
  applyBlockChunking,
  // Combined normalization
  normalizeText,
  normalizePayload,
  normalizeStreamingText,
  // Types
  type NormalizationOptions,
  type NormalizationResult,
  type BlockChunkingConfig,
} from "./normalization.js";

// Turn Executor
export {
  DefaultTurnExecutor,
  createTurnExecutor,
  type TurnExecutor,
  type TurnExecutorLogger,
  type TurnExecutorOptions,
  type RuntimeAdapter,
  type RuntimeAdapterParams,
  type RuntimeAdapterResult,
} from "./executor.js";

// Execution Kernel (the main entry point)
export {
  DefaultExecutionKernel,
  createExecutionKernel,
  createDefaultExecutionKernel,
  type ExecutionKernel,
  type ExecutionKernelLogger,
  type ExecutionKernelOptions,
} from "./kernel.js";
