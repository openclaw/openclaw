/**
 * Failure Economics - Error Taxonomy and Response Mapping
 *
 * This module implements Milestone D of the Post-Performance Improvements:
 * - D1: Error taxonomy enum/constants
 * - D2-D6: Specific error classes for each taxonomy type
 * - D7: Error-to-response mapping with predefined responses per error class
 *
 * @module contracts/error-taxonomy
 *
 * Principles:
 * - Max 1 retry per executor (D8)
 * - Same failure twice → escalate to planner (D9)
 * - Each error class has a predefined response path
 * - No hidden retry loops, no brute-force attempts
 */

// ============================================================================
// D1: Error Taxonomy Enum/Constants
// ============================================================================

/**
 * Error taxonomy categories for classifying failures explicitly.
 *
 * Each error type maps to a specific response strategy.
 */
export enum ErrorTaxonomy {
  /** Schema validation failed - input/output doesn't match contract */
  SCHEMA_VIOLATION = "schema_violation",

  /** Model returned error, refused, or produced invalid output */
  MODEL_FAILURE = "model_failure",

  /** Tool execution failed (shell, browser, file, etc.) */
  TOOL_FAILURE = "tool_failure",

  /** Resource limits exceeded (tokens, memory, rate limits) */
  RESOURCE_EXHAUSTION = "resource_exhaustion",

  /** System invariant violated (contract breach, unauthorized action) */
  INVARIANT_VIOLATION = "invariant_violation",

  /** Context window exceeded, compaction failed */
  CONTEXT_OVERFLOW = "context_overflow",

  /** Execution timed out */
  TIMEOUT = "timeout",

  /** Execution was aborted */
  ABORT = "abort",

  /** Uncategorized/unknown error */
  UNKNOWN = "unknown",
}

/**
 * Reason codes for why an escalation occurred.
 */
export enum EscalationReason {
  /** Same failure occurred twice - requires planner intervention */
  REPEATED_FAILURE = "repeated_failure",

  /** Context overflow that couldn't be resolved */
  CONTEXT_OVERFLOW = "context_overflow",

  /** Model refused the request */
  MODEL_REFUSAL = "model_refusal",

  /** Budget (tokens, cost) exceeded */
  BUDGET_EXCEEDED = "budget_exceeded",

  /** System invariant was violated */
  INVARIANT_VIOLATION = "invariant_violation",

  /** Required tool unavailable */
  TOOL_UNAVAILABLE = "tool_unavailable",

  /** User explicitly requested escalation */
  USER_REQUESTED = "user_requested",
}

/**
 * Suggested actions for escalation handler.
 */
export enum EscalationAction {
  /** Retry with a different model */
  RETRY_DIFFERENT_MODEL = "retry_different_model",

  /** Retry with context compaction */
  RETRY_WITH_COMPACTION = "retry_with_compaction",

  /** Abort the operation */
  ABORT = "abort",

  /** Ask user for guidance */
  ASK_USER = "ask_user",

  /** Fallback to degraded mode */
  FALLBACK = "fallback",
}

// ============================================================================
// Error Severity Levels
// ============================================================================

/**
 * Severity levels for error classification.
 */
export enum ErrorSeverity {
  /** Recoverable without user intervention */
  LOW = "low",

  /** May require retry with changes */
  MEDIUM = "medium",

  /** Requires escalation or user intervention */
  HIGH = "high",

  /** System integrity at risk */
  CRITICAL = "critical",
}

// ============================================================================
// Base Error Class
// ============================================================================

/**
 * Base class for all OpenClaw errors with taxonomy metadata.
 */
export abstract class OpenClawError extends Error {
  /** Error taxonomy category */
  abstract readonly taxonomy: ErrorTaxonomy;

  /** Error severity level */
  abstract readonly severity: ErrorSeverity;

  /** Whether this error is retryable */
  abstract readonly retryable: boolean;

  /** Whether retry requires changed input */
  readonly requiresChangedInput: boolean;

  /** Suggested escalation action */
  abstract readonly suggestedAction: EscalationAction;

  /** Additional context/metadata */
  readonly context: Record<string, unknown>;

  /** Timestamp when error occurred */
  readonly timestamp: number;

  constructor(
    message: string,
    options: {
      requiresChangedInput?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.requiresChangedInput = options.requiresChangedInput ?? true;
    this.context = options.context ?? {};
    this.timestamp = Date.now();
  }

  /**
   * Convert to a plain object for serialization (e.g., for Result.error).
   */
  toJSON(): {
    taxonomy: ErrorTaxonomy;
    severity: ErrorSeverity;
    message: string;
    retryable: boolean;
    suggestedAction: EscalationAction;
    context: Record<string, unknown>;
    timestamp: number;
  } {
    return {
      taxonomy: this.taxonomy,
      severity: this.severity,
      message: this.message,
      retryable: this.retryable,
      suggestedAction: this.suggestedAction,
      context: this.context,
      timestamp: this.timestamp,
    };
  }
}

// ============================================================================
// D2-D6: Specific Error Classes
// ============================================================================

/**
 * D2: SchemaViolationError - Contract/schema validation failed
 *
 * Use when:
 * - Input doesn't match expected schema
 * - Output parsing fails
 * - Required fields are missing
 */
export class SchemaViolationError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.SCHEMA_VIOLATION;
  readonly severity = ErrorSeverity.MEDIUM;
  readonly retryable = true;
  readonly suggestedAction = EscalationAction.RETRY_WITH_COMPACTION;

  /** Schema that was violated (if applicable) */
  readonly schemaName?: string;

  /** Validation errors */
  readonly validationErrors?: string[];

  constructor(
    message: string,
    options: {
      schemaName?: string;
      validationErrors?: string[];
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      requiresChangedInput: true,
      context: options.context,
      cause: options.cause,
    });
    this.schemaName = options.schemaName;
    this.validationErrors = options.validationErrors;
  }
}

/**
 * D3: ModelFailureError - Model-related failures
 *
 * Use when:
 * - Model returns an error response
 * - Model refuses to process
 * - Model produces invalid/unparseable output
 * - Model hallucinates or produces nonsense
 */
export class ModelFailureError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.MODEL_FAILURE;
  readonly severity = ErrorSeverity.MEDIUM;
  readonly retryable = true;
  readonly suggestedAction = EscalationAction.RETRY_DIFFERENT_MODEL;

  /** Model ID that failed */
  readonly modelId?: string;

  /** Provider that hosted the model */
  readonly provider?: string;

  /** Type of model failure */
  readonly failureType: "error" | "refusal" | "invalid_output" | "hallucination";

  constructor(
    message: string,
    options: {
      failureType: "error" | "refusal" | "invalid_output" | "hallucination";
      modelId?: string;
      provider?: string;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, {
      requiresChangedInput: true,
      context: options.context,
      cause: options.cause,
    });
    this.failureType = options.failureType;
    this.modelId = options.modelId;
    this.provider = options.provider;
  }
}

/**
 * D4: ToolFailureError - Tool execution failures
 *
 * Use when:
 * - Shell command fails
 * - Browser automation fails
 * - File operation fails
 * - External API call fails
 */
export class ToolFailureError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.TOOL_FAILURE;
  readonly severity = ErrorSeverity.MEDIUM;
  readonly retryable = true;
  readonly suggestedAction = EscalationAction.RETRY_WITH_COMPACTION;

  /** Tool name that failed */
  readonly toolName: string;

  /** Tool exit code (if applicable) */
  readonly exitCode?: number;

  /** Tool stderr output (if applicable) */
  readonly stderr?: string;

  constructor(
    message: string,
    options: {
      toolName: string;
      exitCode?: number;
      stderr?: string;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, {
      requiresChangedInput: false, // Tool failures may retry with same input
      context: options.context,
      cause: options.cause,
    });
    this.toolName = options.toolName;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr;
  }
}

/**
 * D5: ResourceExhaustionError - Resource limits exceeded
 *
 * Use when:
 * - Token budget exceeded
 * - Rate limit hit
 * - Memory pressure too high
 * - Disk/quota exceeded
 */
export class ResourceExhaustionError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.RESOURCE_EXHAUSTION;
  readonly severity = ErrorSeverity.HIGH;
  readonly retryable = false; // Can't retry without reducing demand
  readonly suggestedAction = EscalationAction.RETRY_WITH_COMPACTION;

  /** Resource type that was exhausted */
  readonly resourceType: "tokens" | "rate_limit" | "memory" | "disk" | "quota" | "other";

  /** Current usage */
  readonly currentUsage?: number;

  /** Maximum allowed */
  readonly maximumAllowed?: number;

  constructor(
    message: string,
    options: {
      resourceType: "tokens" | "rate_limit" | "memory" | "disk" | "quota" | "other";
      currentUsage?: number;
      maximumAllowed?: number;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, {
      requiresChangedInput: true,
      context: options.context,
      cause: options.cause,
    });
    this.resourceType = options.resourceType;
    this.currentUsage = options.currentUsage;
    this.maximumAllowed = options.maximumAllowed;
  }
}

/**
 * D6: InvariantViolationError - System invariant breach
 *
 * Use when:
 * - Dispatcher supremacy violated
 * - Unauthorized component tries to route/escalate/write memory
 * - Contract breached in an unrecoverable way
 */
export class InvariantViolationError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.INVARIANT_VIOLATION;
  readonly severity = ErrorSeverity.CRITICAL;
  readonly retryable = false; // Never retry invariants
  readonly suggestedAction = EscalationAction.ABORT;

  /** Invariant that was violated */
  readonly invariant: string;

  /** Component that violated the invariant */
  readonly violator?: string;

  constructor(
    message: string,
    options: {
      invariant: string;
      violator?: string;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, {
      requiresChangedInput: false, // Invariants can't be fixed by changing input
      context: options.context,
      cause: options.cause,
    });
    this.invariant = options.invariant;
    this.violator = options.violator;
  }
}

/**
 * ContextOverflowError - Context window exceeded
 *
 * Use when:
 * - Prompt exceeds model context window
 * - Compaction fails to reduce context
 */
export class ContextOverflowError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.CONTEXT_OVERFLOW;
  readonly severity = ErrorSeverity.HIGH;
  readonly retryable = true;
  readonly suggestedAction = EscalationAction.RETRY_WITH_COMPACTION;

  /** Current token count */
  readonly currentTokens?: number;

  /** Maximum allowed tokens */
  readonly maxTokens?: number;

  constructor(
    message: string,
    options: {
      currentTokens?: number;
      maxTokens?: number;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      requiresChangedInput: true,
      context: options.context,
      cause: options.cause,
    });
    this.currentTokens = options.currentTokens;
    this.maxTokens = options.maxTokens;
  }
}

/**
 * TimeoutError - Execution timed out
 */
export class TimeoutError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.TIMEOUT;
  readonly severity = ErrorSeverity.MEDIUM;
  readonly retryable = true;
  readonly suggestedAction = EscalationAction.RETRY_DIFFERENT_MODEL;

  /** Timeout duration in ms */
  readonly timeoutMs: number;

  constructor(
    message: string,
    options: {
      timeoutMs: number;
      context?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, {
      requiresChangedInput: false,
      context: options.context,
      cause: options.cause,
    });
    this.timeoutMs = options.timeoutMs;
  }
}

/**
 * AbortError - Execution was aborted
 */
export class AbortError extends OpenClawError {
  readonly taxonomy = ErrorTaxonomy.ABORT;
  readonly severity = ErrorSeverity.LOW;
  readonly retryable = false;
  readonly suggestedAction = EscalationAction.ABORT;

  /** Abort reason */
  readonly abortReason?: string;

  constructor(
    message: string,
    options: {
      abortReason?: string;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, {
      requiresChangedInput: false,
      context: options.context,
      cause: options.cause,
    });
    this.abortReason = options.abortReason;
  }
}

// ============================================================================
// D7: Error-to-Response Mapping
// ============================================================================

/**
 * Response configuration for an error taxonomy type.
 */
export interface ErrorResponseConfig {
  /** Whether this error can be retried */
  retryable: boolean;

  /** Max retry attempts (Failure Economics: max 1) */
  maxRetries: number;

  /** Whether retry requires different input */
  requiresChangedInput: boolean;

  /** Suggested escalation action */
  suggestedAction: EscalationAction;

  /** Whether same failure should trigger escalation */
  escalateOnRepeat: boolean;

  /** Severity level */
  severity: ErrorSeverity;

  /** User-facing message template */
  userMessage: string;
}

/**
 * Predefined response mapping for each error taxonomy type.
 *
 * This is the core of D7 - each error class has a deterministic response path.
 */
export const ERROR_RESPONSE_MAP: Record<ErrorTaxonomy, ErrorResponseConfig> = {
  [ErrorTaxonomy.SCHEMA_VIOLATION]: {
    retryable: true,
    maxRetries: 1,
    requiresChangedInput: true,
    suggestedAction: EscalationAction.RETRY_WITH_COMPACTION,
    escalateOnRepeat: true,
    severity: ErrorSeverity.MEDIUM,
    userMessage: "The response format was invalid. Retrying with adjusted parameters.",
  },

  [ErrorTaxonomy.MODEL_FAILURE]: {
    retryable: true,
    maxRetries: 1,
    requiresChangedInput: true,
    suggestedAction: EscalationAction.RETRY_DIFFERENT_MODEL,
    escalateOnRepeat: true,
    severity: ErrorSeverity.MEDIUM,
    userMessage: "The AI model encountered an issue. Trying with a different approach.",
  },

  [ErrorTaxonomy.TOOL_FAILURE]: {
    retryable: true,
    maxRetries: 1,
    requiresChangedInput: false, // Tool failures can retry same input
    suggestedAction: EscalationAction.RETRY_WITH_COMPACTION,
    escalateOnRepeat: true,
    severity: ErrorSeverity.MEDIUM,
    userMessage: "A tool encountered an error. Retrying with adjusted settings.",
  },

  [ErrorTaxonomy.RESOURCE_EXHAUSTION]: {
    retryable: false, // Can't retry without reducing demand
    maxRetries: 0,
    requiresChangedInput: true,
    suggestedAction: EscalationAction.RETRY_WITH_COMPACTION,
    escalateOnRepeat: false, // Already escalated by nature
    severity: ErrorSeverity.HIGH,
    userMessage: "Resource limits reached. Escalating to reduce demand.",
  },

  [ErrorTaxonomy.INVARIANT_VIOLATION]: {
    retryable: false,
    maxRetries: 0,
    requiresChangedInput: false,
    suggestedAction: EscalationAction.ABORT,
    escalateOnRepeat: false,
    severity: ErrorSeverity.CRITICAL,
    userMessage: "A system invariant was violated. Aborting for safety.",
  },

  [ErrorTaxonomy.CONTEXT_OVERFLOW]: {
    retryable: true,
    maxRetries: 1,
    requiresChangedInput: true,
    suggestedAction: EscalationAction.RETRY_WITH_COMPACTION,
    escalateOnRepeat: true,
    severity: ErrorSeverity.HIGH,
    userMessage: "Context limit reached. Compressing and retrying.",
  },

  [ErrorTaxonomy.TIMEOUT]: {
    retryable: true,
    maxRetries: 1,
    requiresChangedInput: false,
    suggestedAction: EscalationAction.RETRY_DIFFERENT_MODEL,
    escalateOnRepeat: true,
    severity: ErrorSeverity.MEDIUM,
    userMessage: "Request timed out. Retrying with adjusted timeout.",
  },

  [ErrorTaxonomy.ABORT]: {
    retryable: false,
    maxRetries: 0,
    requiresChangedInput: false,
    suggestedAction: EscalationAction.ABORT,
    escalateOnRepeat: false,
    severity: ErrorSeverity.LOW,
    userMessage: "Operation was cancelled.",
  },

  [ErrorTaxonomy.UNKNOWN]: {
    retryable: false,
    maxRetries: 0,
    requiresChangedInput: false,
    suggestedAction: EscalationAction.ASK_USER,
    escalateOnRepeat: false,
    severity: ErrorSeverity.HIGH,
    userMessage: "An unexpected error occurred. Escalating for review.",
  },
};

/**
 * Get response configuration for an error taxonomy type.
 */
export function getErrorResponseConfig(taxonomy: ErrorTaxonomy): ErrorResponseConfig {
  return ERROR_RESPONSE_MAP[taxonomy] ?? ERROR_RESPONSE_MAP[ErrorTaxonomy.UNKNOWN];
}

/**
 * Check if an error is retryable under Failure Economics rules.
 *
 * Rules:
 * - Max 1 retry (D8)
 * - Must have changed input if required (D8)
 * - Same failure twice → escalate (D9)
 */
export function isRetryable(
  error: OpenClawError | ErrorTaxonomy,
  previousAttempts: number,
  hasChangedInput: boolean,
): boolean {
  const taxonomy = typeof error === "string" ? error : error.taxonomy;
  const config = getErrorResponseConfig(taxonomy);

  // Check max retries (max 1 under Failure Economics)
  // previousAttempts is the number of retries already attempted
  // if previousAttempts >= maxRetries, we've exhausted retries
  if (previousAttempts >= config.maxRetries) {
    return false;
  }

  // Check if retryable at all
  if (!config.retryable) {
    return false;
  }

  // Check if input change is required
  if (config.requiresChangedInput && !hasChangedInput) {
    return false;
  }

  return true;
}

/**
 * Determine if an error should trigger escalation.
 *
 * Triggers escalation when:
 * - Same failure occurs twice (D9)
 * - Error is not retryable and has high/critical severity
 * - Resource exhaustion (requires demand reduction)
 * - Invariant violation (system integrity at risk)
 */
export function shouldEscalate(
  error: OpenClawError,
  previousErrors: OpenClawError[],
): { shouldEscalate: boolean; reason?: EscalationReason; action?: EscalationAction } {
  const config = getErrorResponseConfig(error.taxonomy);

  // Check for repeated failure (D9)
  const sameFailureCount = previousErrors.filter(
    (e) => e.taxonomy === error.taxonomy && e.message === error.message,
  ).length;

  if (config.escalateOnRepeat && sameFailureCount >= 1) {
    return {
      shouldEscalate: true,
      reason: EscalationReason.REPEATED_FAILURE,
      action: config.suggestedAction,
    };
  }

  // Non-retryable high/critical severity errors escalate immediately
  if (
    !config.retryable &&
    (config.severity === ErrorSeverity.HIGH || config.severity === ErrorSeverity.CRITICAL)
  ) {
    const reasonMap: Record<ErrorTaxonomy, EscalationReason | undefined> = {
      [ErrorTaxonomy.RESOURCE_EXHAUSTION]: EscalationReason.BUDGET_EXCEEDED,
      [ErrorTaxonomy.INVARIANT_VIOLATION]: EscalationReason.INVARIANT_VIOLATION,
      [ErrorTaxonomy.CONTEXT_OVERFLOW]: EscalationReason.CONTEXT_OVERFLOW,
      [ErrorTaxonomy.MODEL_FAILURE]: EscalationReason.MODEL_REFUSAL,
      [ErrorTaxonomy.SCHEMA_VIOLATION]: undefined,
      [ErrorTaxonomy.TOOL_FAILURE]: EscalationReason.TOOL_UNAVAILABLE,
      [ErrorTaxonomy.TIMEOUT]: undefined,
      [ErrorTaxonomy.ABORT]: undefined,
      [ErrorTaxonomy.UNKNOWN]: undefined,
    };

    return {
      shouldEscalate: true,
      reason: reasonMap[error.taxonomy] ?? EscalationReason.USER_REQUESTED,
      action: config.suggestedAction,
    };
  }

  return { shouldEscalate: false };
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if an error is an OpenClawError.
 */
export function isOpenClawError(err: unknown): err is OpenClawError {
  return err instanceof OpenClawError;
}

/**
 * Check if an error is a specific taxonomy type.
 */
export function isErrorTaxonomy(err: unknown, taxonomy: ErrorTaxonomy): boolean {
  return isOpenClawError(err) && err.taxonomy === taxonomy;
}

/**
 * Extract taxonomy from an error (returns UNKNOWN if not an OpenClawError).
 */
export function getErrorTaxonomy(err: unknown): ErrorTaxonomy {
  if (isOpenClawError(err)) {
    return err.taxonomy;
  }
  return ErrorTaxonomy.UNKNOWN;
}
