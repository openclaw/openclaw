/**
 * Failure Economics - Retry Policy Enforcement
 *
 * This module implements:
 * - D8: Max 1 retry policy with changed input requirement
 * - D9: Same failure twice → escalate logic
 *
 * @module infra/retry-policy
 *
 * Principles:
 * - Max 1 retry per executor (no brute-force)
 * - Retry must use different input if required by error type
 * - Same failure twice triggers escalation to planner
 * - All retry decisions are deterministic and observable
 */

import {
  type OpenClawError,
  type ErrorTaxonomy,
  ErrorSeverity,
  EscalationReason,
  type EscalationAction,
  isOpenClawError,
  getErrorTaxonomy,
  getErrorResponseConfig,
  shouldEscalate,
} from "../contracts/error-taxonomy.js";

/**
 * Configuration for retry policy enforcement.
 */
export interface RetryPolicyConfig {
  /** Maximum retries allowed (default: 1 under Failure Economics) */
  maxRetries: number;

  /** Whether to require input changes for retry */
  requireChangedInput: boolean;

  /** Whether to track failure history for escalation detection */
  trackFailureHistory: boolean;
}

/**
 * Default Failure Economics retry policy.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicyConfig = {
  maxRetries: 1,
  requireChangedInput: true,
  trackFailureHistory: true,
};

/**
 * Outcome of a retry policy evaluation.
 */
export type RetryOutcome =
  | { decision: "retry"; strategy: RetryStrategy }
  | {
      decision: "escalate";
      reason: EscalationReason;
      action: EscalationAction;
      failedResult: FailureRecord;
    }
  | { decision: "fail"; error: string };

/**
 * Strategy for retrying an operation.
 */
export interface RetryStrategy {
  /** Attempt number (1-based) */
  attempt: number;

  /** Whether input must be changed */
  requiresChangedInput: boolean;

  /** Suggested changes to input */
  suggestedChanges?: InputChanges;

  /** Maximum time to wait for this attempt */
  timeoutMs?: number;
}

/**
 * Changes to apply to input for retry.
 */
export interface InputChanges {
  /** Use compact/minimal context */
  compactContext?: boolean;

  /** Use different model */
  changeModel?: boolean;

  /** Suggested model to use */
  suggestedModel?: string;

  /** Reduce context budget */
  reduceContextBudget?: boolean;

  /** New context budget */
  newContextBudget?: number;

  /** Additional context for retry */
  retryContext?: Record<string, unknown>;
}

/**
 * Record of a failure for history tracking.
 */
export interface FailureRecord {
  /** Error taxonomy */
  taxonomy: ErrorTaxonomy;

  /** Error message */
  message: string;

  /** Error severity */
  severity: ErrorSeverity;

  /** Timestamp */
  timestamp: number;

  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Retry policy enforcer with failure history tracking.
 *
 * Implements D8 and D9 of Failure Economics:
 * - Max 1 retry per executor
 * - Changed input required for certain error types
 * - Same failure twice → escalate
 */
export class RetryPolicyEnforcer {
  private config: RetryPolicyConfig;
  private failureHistory: FailureRecord[] = [];
  private currentAttempt = 0;

  constructor(config: Partial<RetryPolicyConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_POLICY, ...config };
  }

  /**
   * Evaluate whether an operation should be retried or escalated.
   *
   * This is the core decision function implementing D8 and D9.
   *
   * @param error - The error that occurred
   * @param hasChangedInput - Whether the input has been changed for retry
   * @returns RetryOutcome with decision and strategy or escalation
   */
  evaluate(error: unknown, hasChangedInput: boolean): RetryOutcome {
    // Check if this is an OpenClawError
    if (!isOpenClawError(error)) {
      // Unknown errors are not retryable under Failure Economics
      return {
        decision: "fail",
        error: `Unknown error type: ${formatErrorForLogging(error)}`,
      };
    }

    // Check for escalation (D9 - same failure twice)
    const escalationCheck = shouldEscalate(error, this.getRelevantHistory(error));
    if (escalationCheck.shouldEscalate) {
      const failureRecord = this.recordFailure(error);
      return {
        decision: "escalate",
        reason: escalationCheck.reason ?? EscalationReason.REPEATED_FAILURE,
        action: escalationCheck.action ?? "ask_user",
        failedResult: failureRecord,
      };
    }

    // Check retry eligibility (D8 - max 1 retry)
    const config = getErrorResponseConfig(error.taxonomy);

    // Check max retries
    if (this.currentAttempt >= config.maxRetries) {
      const failureRecord = this.recordFailure(error);
      return {
        decision: "escalate",
        reason: EscalationReason.REPEATED_FAILURE,
        action: config.suggestedAction,
        failedResult: failureRecord,
      };
    }

    // Check if retryable
    if (!config.retryable) {
      const failureRecord = this.recordFailure(error);
      return {
        decision: "escalate",
        reason: this.mapToEscalationReason(error.taxonomy),
        action: config.suggestedAction,
        failedResult: failureRecord,
      };
    }

    // Check changed input requirement
    if (config.requiresChangedInput && !hasChangedInput) {
      return {
        decision: "fail",
        error: `Retry requires changed input for ${error.taxonomy}`,
      };
    }

    // Retry is allowed
    this.currentAttempt++;
    const strategy = this.buildRetryStrategy(error, this.currentAttempt);

    return {
      decision: "retry",
      strategy,
    };
  }

  /**
   * Record a failure for history tracking.
   */
  recordFailure(error: OpenClawError): FailureRecord {
    const record: FailureRecord = {
      taxonomy: error.taxonomy,
      message: error.message,
      severity: error.severity,
      timestamp: error.timestamp,
      context: error.context,
    };

    if (this.config.trackFailureHistory) {
      this.failureHistory.push(record);
    }

    return record;
  }

  /**
   * Get failure history for a specific error type.
   */
  getRelevantHistory(error: OpenClawError): OpenClawError[] {
    return this.failureHistory
      .filter((record) => record.taxonomy === error.taxonomy && record.message === error.message)
      .map(
        (record) =>
          ({
            taxonomy: record.taxonomy,
            message: record.message,
            severity: record.severity,
            timestamp: record.timestamp,
            context: record.context ?? {},
          }) as OpenClawError,
      );
  }

  /**
   * Get all failure history.
   */
  getFailureHistory(): readonly FailureRecord[] {
    return this.failureHistory;
  }

  /**
   * Get current attempt count.
   */
  getCurrentAttempt(): number {
    return this.currentAttempt;
  }

  /**
   * Reset the enforcer state.
   */
  reset(): void {
    this.failureHistory = [];
    this.currentAttempt = 0;
  }

  /**
   * Build a retry strategy for the given error.
   */
  private buildRetryStrategy(error: OpenClawError, attempt: number): RetryStrategy {
    const config = getErrorResponseConfig(error.taxonomy);

    const strategy: RetryStrategy = {
      attempt,
      requiresChangedInput: config.requiresChangedInput,
    };

    // Suggest input changes based on error type
    switch (error.taxonomy) {
      case "schema_violation":
        strategy.suggestedChanges = {
          compactContext: true,
          retryContext: { schemaHints: "Use stricter output format" },
        };
        break;

      case "model_failure":
        strategy.suggestedChanges = {
          changeModel: true,
          retryContext: { modelHints: "Try more capable model" },
        };
        break;

      case "tool_failure":
        strategy.suggestedChanges = {
          retryContext: { toolHints: "Check tool availability" },
        };
        break;

      case "context_overflow":
        strategy.suggestedChanges = {
          compactContext: true,
          reduceContextBudget: true,
          newContextBudget: 80000, // Suggest reduced budget
        };
        break;

      case "timeout":
        strategy.timeoutMs = 60000; // Suggest longer timeout
        break;

      default:
        strategy.suggestedChanges = { compactContext: true };
    }

    return strategy;
  }

  /**
   * Map error taxonomy to escalation reason.
   */
  private mapToEscalationReason(taxonomy: ErrorTaxonomy): EscalationReason {
    const mapping: Record<ErrorTaxonomy, EscalationReason> = {
      schema_violation: EscalationReason.REPEATED_FAILURE,
      model_failure: EscalationReason.MODEL_REFUSAL,
      tool_failure: EscalationReason.TOOL_UNAVAILABLE,
      resource_exhaustion: EscalationReason.BUDGET_EXCEEDED,
      invariant_violation: EscalationReason.INVARIANT_VIOLATION,
      context_overflow: EscalationReason.CONTEXT_OVERFLOW,
      timeout: EscalationReason.REPEATED_FAILURE,
      abort: EscalationReason.USER_REQUESTED,
      unknown: EscalationReason.REPEATED_FAILURE,
    };

    return mapping[taxonomy];
  }
}

/**
 * Create a retry policy enforcer with default Failure Economics config.
 */
export function createRetryPolicyEnforcer(
  config?: Partial<RetryPolicyConfig>,
): RetryPolicyEnforcer {
  return new RetryPolicyEnforcer(config);
}

/**
 * Quick check if an error should be retried.
 *
 * Use this for simple cases where you don't need full history tracking.
 *
 * @param error - The error that occurred
 * @param attempt - Current attempt number (0-based)
 * @param hasChangedInput - Whether input has been changed
 * @returns Whether retry is allowed
 */
export function shouldRetry(error: unknown, attempt: number, hasChangedInput: boolean): boolean {
  if (!isOpenClawError(error)) {
    return false;
  }

  const config = getErrorResponseConfig(error.taxonomy);

  // Check max retries
  if (attempt >= config.maxRetries) {
    return false;
  }

  // Check if retryable
  if (!config.retryable) {
    return false;
  }

  // Check changed input requirement
  if (config.requiresChangedInput && !hasChangedInput) {
    return false;
  }

  return true;
}

/**
 * Format an error for logging.
 */
function formatErrorForLogging(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ============================================================================
// Executor Integration Helpers
// ============================================================================

/**
 * Options for executing with retry policy.
 */
export interface ExecuteWithRetryOptions<T> {
  /** Operation to execute */
  operation: () => Promise<T>;

  /** Function to check if input has changed */
  hasChangedInput: () => boolean;

  /** Function to modify input for retry */
  changeInput?: (strategy: RetryStrategy) => void;

  /** Called when escalation is needed */
  onEscalate?: (reason: EscalationReason, action: EscalationAction, record: FailureRecord) => void;

  /** Called when operation fails permanently */
  onFail?: (error: string) => void;

  /** Retry policy configuration */
  policy?: Partial<RetryPolicyConfig>;
}

/**
 * Execute an operation with Failure Economics retry policy.
 *
 * This is a high-level helper that orchestrates the retry loop
 * according to Failure Economics rules.
 *
 * @example
 * ```ts
 * const result = await executeWithRetry({
 *   operation: () => callModel(prompt),
 *   hasChangedInput: () => hasContextChanged(),
 *   changeInput: (strategy) => {
 *     if (strategy.suggestedChanges?.compactContext) {
 *       compactTheContext();
 *     }
 *   },
 *   onEscalate: (reason, action) => {
 *     escalateToPlanner(reason, action);
 *   },
 * });
 * ```
 */
export async function executeWithRetry<T>(options: ExecuteWithRetryOptions<T>): Promise<T | null> {
  const enforcer = createRetryPolicyEnforcer(options.policy);

  while (true) {
    try {
      const result = await options.operation();
      return result;
    } catch (error) {
      const outcome = enforcer.evaluate(error, options.hasChangedInput());

      switch (outcome.decision) {
        case "retry": {
          // Apply input changes if provided
          if (options.changeInput && outcome.strategy.suggestedChanges) {
            options.changeInput(outcome.strategy);
          }
          // Continue to next iteration
          break;
        }

        case "escalate": {
          options.onEscalate?.(outcome.reason, outcome.action, outcome.failedResult);
          return null;
        }

        case "fail": {
          options.onFail?.(outcome.error);
          return null;
        }
      }
    }
  }
}
