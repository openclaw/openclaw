import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MemoryCitationsMode } from "../config/types.memory.js";

// Result types

export type AssembleResult = {
  /** Ordered messages to use as model context */
  messages: AgentMessage[];
  /** Estimated total tokens in assembled context */
  estimatedTokens: number;
  /**
   * Controls which token estimate the runner treats as authoritative for
   * preemptive overflow prechecks. The returned `messages` are always the
   * prompt sent to the model; this only affects the precheck's token comparison.
   *
   * - "assembled": the precheck uses only the assembled prompt's estimate.
   * - "preassembly_may_overflow": the precheck takes the maximum of the
   *   assembled estimate and the pre-assembly (unwindowed) session-history
   *   estimate. Engines opt into this when their assembled view can hide an
   *   overflow that would still affect the underlying transcript.
   *
   * Defaults to "assembled".
   */
  promptAuthority?: "assembled" | "preassembly_may_overflow";
  /** Optional context-engine-provided instructions prepended to the runtime system prompt */
  systemPromptAddition?: string;
  /**
   * Optional projection lifecycle for hosts with persistent backend threads.
   *
   * Context engines that return `thread_bootstrap` ask the host to inject the
   * assembled context once for the supplied epoch, then reuse the backend
   * thread until the epoch changes. Engines that omit this field retain the
   * legacy per-turn projection behavior.
   */
  contextProjection?: ContextEngineProjection;
};

export type ContextEngineProjection = {
  /** How the assembled context should be projected into the backend runtime. */
  mode: "per_turn" | "thread_bootstrap";
  /** Stable context epoch. Changing this tells persistent backends to rotate. */
  epoch?: string;
  /** Optional diagnostic fingerprint for the projected context payload. */
  fingerprint?: string;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
    /** Session id after compaction, when the runtime rotated transcripts. */
    sessionId?: string;
    /** Session file after compaction, when the runtime rotated transcripts. */
    sessionFile?: string;
  };
};

/**
 * Request payload for {@link ContextEngine.interceptCompaction}.
 *
 * Mirrors the fields the runtime supplies when emitting the
 * `session_before_compact` event in {@link
 * https://github.com/mariozechner/pi-coding-agent | pi-coding-agent} so engines
 * can produce a replacement compaction without depending on the SDK event type
 * directly.
 */
export type CompactionInterceptRequest = {
  /** Session id of the conversation to intercept compaction for. */
  sessionId: string;
  /** Optional session key (agent:id:suffix form). */
  sessionKey?: string;
  /** On-disk path to the session jsonl. */
  sessionFile: string;
  /** Total context window in tokens (when known). */
  tokenBudget?: number;
  /** Best-effort current token estimate at the time of compaction. */
  currentTokenCount?: number;
  /** First entry id the runtime intends to keep verbatim (compaction boundary). */
  firstKeptEntryId: string;
  /** Pre-compaction token count reported by the runtime. */
  tokensBefore: number;
  /**
   * Trigger source for the compaction request. Useful for routing/diagnostics
   * (e.g. honoring different cadence policies for overflow vs in-attempt-auto).
   */
  trigger?: "in-attempt-auto" | "overflow" | "timeout" | "manual";
  /** Abort signal honored before and during compaction. */
  signal?: AbortSignal;
};

/**
 * Result payload for {@link ContextEngine.interceptCompaction}.
 *
 * `handled: true` provides a replacement compaction that the runtime uses in
 * place of its default GPT-driven path. `handled: false` opts out and the
 * runtime falls back to its default (codex compaction or safeguard
 * summarization, depending on configuration).
 */
export type CompactionInterceptResult =
  | {
      /** True when the engine produced a replacement compaction. */
      handled: true;
      /** Summary text to use in place of the runtime's default compaction. */
      summary: string;
      /** First entry id retained after compaction. */
      firstKeptEntryId: string;
      /** Token count before compaction (echoed from request). */
      tokensBefore: number;
      /** Estimated token count after compaction (diagnostic, optional). */
      tokensAfter?: number;
      /** Optional engine-specific diagnostic payload. */
      details?: unknown;
    }
  | {
      /** False when the engine declines to intercept; the caller falls back. */
      handled: false;
      /** Short reason code for diagnostics (e.g. "session-ignored"). */
      reason: string;
    };

export type IngestResult = {
  /** Whether the message was ingested (false if duplicate or no-op) */
  ingested: boolean;
};

export type IngestBatchResult = {
  /** Number of messages ingested from the supplied batch */
  ingestedCount: number;
};

export type BootstrapResult = {
  /** Whether bootstrap ran and initialized the engine's store */
  bootstrapped: boolean;
  /** Number of historical messages imported (if applicable) */
  importedMessages?: number;
  /** Optional reason when bootstrap was skipped */
  reason?: string;
};

export type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  /** True when the engine manages its own compaction lifecycle. */
  ownsCompaction?: boolean;
  /**
   * True when the engine implements {@link ContextEngine.interceptCompaction}
   * and intends to override the runtime's default `session_before_compact`
   * compaction path with its own assembly.
   *
   * Distinct from {@link ownsCompaction}: engines that fully own compaction
   * never see the runtime event at all, while engines that intercept run
   * alongside the runtime and only replace the summarization step.
   *
   * The host treats this as authoritative for capability gating (e.g. it
   * auto-zeroes Pi's `reserveTokensFloor` headroom reserve when this is true,
   * because the engine takes responsibility for post-compaction headroom).
   */
  interceptsCompaction?: boolean;
  /**
   * Controls how turn-triggered maintenance should be executed.
   *
   * Engines remain compatible by default unless the host explicitly opts into
   * background turn maintenance.
   */
  turnMaintenanceMode?: "foreground" | "background";
};

export type SubagentSpawnPreparation = {
  /** Roll back pre-spawn setup when subagent launch fails. */
  rollback: () => void | Promise<void>;
};

export type SubagentEndReason = "deleted" | "completed" | "swept" | "released";

export type TranscriptRewriteReplacement = {
  /** Existing transcript entry id to replace on the active branch. */
  entryId: string;
  /** Replacement message content for that entry. */
  message: AgentMessage;
};

export type TranscriptRewriteRequest = {
  /** Message entry replacements to apply in one branch-and-reappend pass. */
  replacements: TranscriptRewriteReplacement[];
};

export type TranscriptRewriteResult = {
  /** Whether the active branch changed. */
  changed: boolean;
  /** Estimated bytes removed from the active branch message payloads. */
  bytesFreed: number;
  /** Number of transcript message entries rewritten. */
  rewrittenEntries: number;
  /** Optional reason when no rewrite occurred. */
  reason?: string;
};

export type ContextEngineMaintenanceResult = TranscriptRewriteResult;

type ContextEnginePromptCacheRetention = "none" | "short" | "long" | "in_memory" | "24h";

type ContextEnginePromptCacheUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

type ContextEnginePromptCacheObservationChangeCode =
  | "cacheRetention"
  | "model"
  | "streamStrategy"
  | "systemPrompt"
  | "tools"
  | "transport";

type ContextEnginePromptCacheObservationChange = {
  code: ContextEnginePromptCacheObservationChangeCode;
  detail: string;
};

type ContextEnginePromptCacheObservation = {
  broke: boolean;
  previousCacheRead?: number;
  cacheRead?: number;
  changes?: ContextEnginePromptCacheObservationChange[];
};

export type ContextEnginePromptCacheInfo = {
  /** Runtime-resolved retention for the actual provider/model/request path. */
  retention?: ContextEnginePromptCacheRetention;
  /** Usage from the most recent API call, not accumulated retry/tool-loop totals. */
  lastCallUsage?: ContextEnginePromptCacheUsage;
  /** Result from the runtime's prompt-cache observability heuristic. */
  observation?: ContextEnginePromptCacheObservation;
  /** Last known cache-touch timestamp from runtime-managed cache-TTL bookkeeping. */
  lastCacheTouchAt?: number;
  /** Known cache expiry time when the runtime can source it confidently. */
  expiresAt?: number;
};

export type ContextEngineRuntimeContext = Record<string, unknown> & {
  /**
   * True when the host has explicitly opted this maintenance run into
   * consuming deferred compaction debt.
   */
  allowDeferredCompactionExecution?: boolean;
  /** Runtime-resolved context window budget for the active model call. */
  tokenBudget?: number;
  /** Best-effort current prompt/context token estimate for this turn. */
  currentTokenCount?: number;
  /** Optional prompt-cache telemetry for cache-aware engines. */
  promptCache?: ContextEnginePromptCacheInfo;
  /**
   * Safe transcript rewrite helper implemented by the runtime.
   *
   * Engines decide what is safe to rewrite; the runtime owns how the session
   * DAG is updated on disk.
   */
  rewriteTranscriptEntries?: (
    request: TranscriptRewriteRequest,
  ) => Promise<TranscriptRewriteResult>;
  /** LLM completion capability for engines that need model inference. */
  llm?: {
    complete: (
      params: import("../plugins/runtime/types-core.js").LlmCompleteParams,
    ) => Promise<import("../plugins/runtime/types-core.js").LlmCompleteResult>;
  };
};

/**
 * ContextEngine defines the pluggable contract for context management.
 *
 * Required methods define a generic lifecycle; optional methods allow engines
 * to provide additional capabilities (retrieval, lineage, etc.).
 */
export interface ContextEngine {
  /** Engine identifier and metadata */
  readonly info: ContextEngineInfo;

  /**
   * Initialize engine state for a session, optionally importing historical context.
   */
  bootstrap?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;

  /**
   * Run transcript maintenance after bootstrap, successful turns, or compaction.
   *
   * Engines can use runtimeContext.rewriteTranscriptEntries() to request safe
   * branch-and-reappend transcript rewrites without depending on Pi internals.
   */
  maintain?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<ContextEngineMaintenanceResult>;

  /**
   * Ingest a single message into the engine's store.
   */
  ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    /** True when the message belongs to a heartbeat run. */
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  /**
   * Ingest a completed turn batch as a single unit.
   */
  ingestBatch?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    /** True when the batch belongs to a heartbeat run. */
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;

  /**
   * Execute optional post-turn lifecycle work after a run attempt completes.
   * Engines can use this to persist canonical context and trigger background
   * compaction decisions.
   */
  afterTurn?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    /** Number of messages that existed before the prompt was sent. */
    prePromptMessageCount: number;
    /** Optional auto-compaction summary emitted by the runtime. */
    autoCompactionSummary?: string;
    /** True when this turn belongs to a heartbeat run. */
    isHeartbeat?: boolean;
    /** Optional model context token budget for proactive compaction. */
    tokenBudget?: number;
    /** Optional runtime-owned context for engines that need caller state. */
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void>;

  /**
   * Assemble model context under a token budget.
   * Returns an ordered set of messages ready for the model.
   */
  assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    /** Tool names available for this run so engines can align prompt guidance with runtime tool access. */
    availableTools?: Set<string>;
    /** Active memory citation mode when engines want to mirror memory prompt guidance. */
    citationsMode?: MemoryCitationsMode;
    /** Current model identifier (e.g. "claude-opus-4", "gpt-4o", "qwen2.5-7b").
     *  Allows context engine plugins to adapt formatting per model. */
    model?: string;
    /** The incoming user prompt for this turn (useful for retrieval-oriented engines). */
    prompt?: string;
  }): Promise<AssembleResult>;

  /**
   * Compact context to reduce token usage.
   * May create summaries, prune old turns, etc.
   *
   * The host always bounds this call with a finite safety timeout (the same
   * one that protects native runtime compaction). Engines that run long
   * operations SHOULD additionally honor `abortSignal` so an in-flight
   * compaction can be canceled promptly on run abort or host timeout instead
   * of running to completion in the background.
   */
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    /** Force compaction even below the default trigger threshold. */
    force?: boolean;
    /** Optional live token estimate from the caller's active context. */
    currentTokenCount?: number;
    /** Controls convergence target; defaults to budget. */
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    /** Optional runtime-owned context for engines that need caller state. */
    runtimeContext?: ContextEngineRuntimeContext;
    /**
     * Optional abort signal honored before and during compaction. The host
     * aborts it on run-level abort or when its compaction safety timeout
     * fires; engines should stop work and reject promptly when it aborts.
     */
    abortSignal?: AbortSignal;
  }): Promise<CompactResult>;

  /**
   * Intercept the runtime's `session_before_compact` event and produce a
   * replacement compaction summary in place of the default GPT-driven path.
   *
   * Engines that implement this MUST set `info.interceptsCompaction = true`
   * so the host can apply intercept-aware capability gating (e.g. zeroing
   * Pi's `reserveTokensFloor` headroom reserve).
   *
   * Return `{ handled: true, ... }` to supply a replacement compaction
   * (runtime uses the summary, skips its default path). Return
   * `{ handled: false, reason }` to opt out (runtime falls back to its
   * default — codex compaction or safeguard summarization).
   *
   * This method MUST never throw across the call boundary — defensive
   * engines should catch internal errors and return
   * `{ handled: false, reason: "..." }`. The host treats a thrown error as
   * `handled: false` and falls back to its default path.
   */
  interceptCompaction?(params: CompactionInterceptRequest): Promise<CompactionInterceptResult>;

  /**
   * Prepare context-engine-managed subagent state before the child run starts.
   *
   * Implementations can return a rollback handle that is invoked when spawn
   * fails after preparation succeeds.
   */
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    contextMode?: "isolated" | "fork";
    parentSessionId?: string;
    parentSessionFile?: string;
    childSessionId?: string;
    childSessionFile?: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;

  /**
   * Notify the context engine that a subagent lifecycle ended.
   */
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;

  /**
   * Dispose of any resources held by the engine.
   */
  dispose?(): Promise<void>;
}
