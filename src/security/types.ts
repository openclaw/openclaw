/**
 * IBEL Phase 1 — Shared type definitions.
 *
 * Leaf module with no internal dependencies. All IBEL modules import from here.
 */

// ── Instruction Level Hierarchy ──────────────────────────────────────────────

/**
 * Privilege levels for instruction sources.
 * Lower numeric value = higher privilege. A lower-privilege instruction
 * cannot override a higher-privilege one.
 */
export enum InstructionLevel {
  /** Framework internals, immutable at runtime. */
  SYSTEM = 0,
  /** Operator-defined governance rules. */
  POLICY = 1,
  /** Current task definition and constraints. */
  TASK = 2,
  /** End-user messages. */
  USER = 3,
  /** RAG results, tool outputs, scraped data. */
  EXTERNAL_CONTENT = 4,
}

// ── Taint Tracking ───────────────────────────────────────────────────────────

/** A single tainted field within an artifact. */
export type TaintField = {
  /** Dot-delimited path to the field (e.g. "args.url"). */
  fieldPath: string;
  /** Privilege level of the data that populated this field. */
  level: InstructionLevel;
  /** Optional provenance label (e.g. "web_fetch", "email"). */
  source?: string;
  /** Timestamp when the taint was applied. */
  taggedAt?: number;
};

/**
 * A content payload tagged with privilege metadata.
 * Produced by TaintTracker.toTaggedPayload() or tagExternalContent().
 */
export type TaggedPayload = {
  /** Worst-case privilege level across all fields. */
  level: InstructionLevel;
  /** The content (string, object, etc.). */
  content: unknown;
  /** Provenance label. */
  source?: string;
  /** Per-field taint when field-level tracking is active. */
  fields?: TaintField[];
  /** Arbitrary metadata for guards/telemetry. */
  metadata?: Record<string, unknown>;
};

// ── Tool Risk ────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Risk metadata for a registered tool. */
export type OpenClawToolMetadata<T = unknown> = {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  /**
   * Translates raw arguments into plain English for HITL approval UIs.
   * Example: (args) => `Execute command: ${args.command}`
   *
   * SECURITY: Templates must be static/pre-validated — never interpolate
   * tainted arguments directly (second-order injection vector).
   */
  humanReadableSummary: (args: T) => string;
};

// ── Execution Context ────────────────────────────────────────────────────────

/**
 * Security context passed to guards during tool validation.
 * Bridges taint tracking into the guard pipeline.
 */
export type ExecutionContext = {
  /** Current task identifier (e.g. job name). */
  activeTask?: string;
  /** Session role (e.g. "owner", "api"). */
  sessionRole?: string;
  /**
   * Worst-case privilege level across all data used to construct this tool call.
   * Defaults to SYSTEM when no taint tracker is attached (backward compat).
   */
  aggregateTaintLevel: InstructionLevel;
  /** Agent identifier. */
  agentId?: string;
  /** Session key for correlation. */
  sessionKey?: string;
  /** Whether the sender is the session owner. */
  senderIsOwner?: boolean;
  /** Access per-field taint when granularity is needed. */
  fieldTaint?: () => TaintField[];
};

// ── Tool Call ────────────────────────────────────────────────────────────────

/** Represents a tool invocation to be validated by the guard pipeline. */
export type ToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
  toolCallId?: string;
};

// ── Validation Results ───────────────────────────────────────────────────────

export type AllowResult = { action: "allow" };

export type BlockResult = {
  action: "block";
  reason: string;
};

export type RepromptResult = {
  action: "reprompt";
  /**
   * Instruction injected into the agent's context to guide recovery.
   * MUST be static/template-safe — never interpolate tainted arguments.
   */
  agentInstruction: string;
  reason: string;
};

export type EscalateResult = {
  action: "escalate";
  requiredRole?: string;
  timeoutMs: number;
  hitlPayload: {
    toolName: string;
    summary: string;
    riskLevel: RiskLevel;
  };
};

export type ValidationResult = AllowResult | BlockResult | RepromptResult | EscalateResult;

// ── Guard Interface ──────────────────────────────────────────────────────────

/**
 * A guard that validates tool calls before execution.
 * Guards run in priority order (highest first); the pipeline short-circuits
 * on the first non-allow result.
 */
export type ToolExecutionGuard = {
  readonly name: string;
  /** Higher priority = runs first. */
  readonly priority: number;
  validate(
    call: ToolCall,
    context: ExecutionContext,
    toolMeta?: OpenClawToolMetadata,
  ): ValidationResult | Promise<ValidationResult>;
};
