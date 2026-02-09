/**
 * OpenClaw AGI - Errors
 *
 * Custom error classes for AGI system with rich context.
 *
 * @module agi/shared/errors
 */

// ============================================================================
// BASE ERROR
// ============================================================================

export class AGIError extends Error {
  public readonly code: string;
  public readonly context: Record<string, unknown>;
  public readonly timestamp: Date;
  public readonly isRetryable: boolean;

  constructor(
    message: string,
    code: string,
    context: Record<string, unknown> = {},
    isRetryable: boolean = false,
  ) {
    super(message);
    this.name = "AGIError";
    this.code = code;
    this.context = context;
    this.timestamp = new Date();
    this.isRetryable = isRetryable;

    // Maintains proper stack trace for where error was thrown
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      isRetryable: this.isRetryable,
      stack: this.stack,
    };
  }

  toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}

// ============================================================================
// DOMAIN ERRORS
// ============================================================================

export class AgentNotFoundError extends AGIError {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`, "AGENT_NOT_FOUND", { agentId }, false);
    this.name = "AgentNotFoundError";
  }
}

export class IntentNotFoundError extends AGIError {
  constructor(intentId: string) {
    super(`Intent not found: ${intentId}`, "INTENT_NOT_FOUND", { intentId }, false);
    this.name = "IntentNotFoundError";
  }
}

export class PlanNotFoundError extends AGIError {
  constructor(planId: string) {
    super(`Plan not found: ${planId}`, "PLAN_NOT_FOUND", { planId }, false);
    this.name = "PlanNotFoundError";
  }
}

export class SessionNotFoundError extends AGIError {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`, "SESSION_NOT_FOUND", { sessionId }, false);
    this.name = "SessionNotFoundError";
  }
}

// ============================================================================
// STATE ERRORS
// ============================================================================

export class InvalidStateError extends AGIError {
  constructor(entity: string, expectedState: string, actualState: string, entityId: string) {
    super(
      `Invalid state for ${entity} ${entityId}: expected ${expectedState}, got ${actualState}`,
      "INVALID_STATE",
      { entity, entityId, expectedState, actualState },
      false,
    );
    this.name = "InvalidStateError";
  }
}

export class DependencyError extends AGIError {
  constructor(entity: string, entityId: string, incompleteDeps: string[]) {
    super(
      `Cannot proceed with ${entity} ${entityId}: incomplete dependencies ${incompleteDeps.join(", ")}`,
      "DEPENDENCY_ERROR",
      { entity, entityId, incompleteDeps },
      false,
    );
    this.name = "DependencyError";
  }
}

export class BlockedError extends AGIError {
  constructor(entity: string, entityId: string, reason: string) {
    super(
      `${entity} ${entityId} is blocked: ${reason}`,
      "BLOCKED",
      { entity, entityId, reason },
      false,
    );
    this.name = "BlockedError";
  }
}

// ============================================================================
// VALIDATION ERRORS
// ============================================================================

export class ValidationError extends AGIError {
  constructor(field: string, value: unknown, requirement: string) {
    super(
      `Validation failed for ${field}: ${requirement}`,
      "VALIDATION_ERROR",
      { field, value, requirement },
      false,
    );
    this.name = "ValidationError";
  }
}

export class RequiredFieldError extends AGIError {
  constructor(field: string) {
    super(`Required field missing: ${field}`, "REQUIRED_FIELD", { field }, false);
    this.name = "RequiredFieldError";
  }
}

// ============================================================================
// DATABASE ERRORS
// ============================================================================

export class DatabaseError extends AGIError {
  constructor(operation: string, originalError: Error) {
    super(
      `Database operation failed: ${operation}`,
      "DATABASE_ERROR",
      { operation, originalError: originalError.message },
      true, // May be retryable
    );
    this.name = "DatabaseError";
  }
}

export class ConcurrencyError extends AGIError {
  constructor(entity: string, entityId: string) {
    super(
      `Concurrent modification detected for ${entity} ${entityId}`,
      "CONCURRENCY_ERROR",
      { entity, entityId },
      true, // Retryable
    );
    this.name = "ConcurrencyError";
  }
}

// ============================================================================
// TIMEOUT ERRORS
// ============================================================================

export class TimeoutError extends AGIError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation timed out: ${operation} (${timeoutMs}ms)`,
      "TIMEOUT",
      { operation, timeoutMs },
      true, // Retryable
    );
    this.name = "TimeoutError";
  }
}

export class IntentTimeoutError extends AGIError {
  constructor(intentId: string, estimatedTime: number, actualTime: number) {
    super(
      `Intent ${intentId} exceeded estimated time: ${estimatedTime}min estimate, ${Math.round(actualTime)}min actual`,
      "INTENT_TIMEOUT",
      { intentId, estimatedTime, actualTime },
      false,
    );
    this.name = "IntentTimeoutError";
  }
}

// ============================================================================
// EXTERNAL SERVICE ERRORS
// ============================================================================

export class ExternalServiceError extends AGIError {
  constructor(service: string, operation: string, statusCode?: number) {
    super(
      `External service error: ${service}.${operation}`,
      "EXTERNAL_SERVICE_ERROR",
      { service, operation, statusCode },
      true, // Usually retryable
    );
    this.name = "ExternalServiceError";
  }
}

export class RateLimitError extends AGIError {
  constructor(service: string, retryAfter?: number) {
    super(
      `Rate limit exceeded for ${service}`,
      "RATE_LIMIT",
      { service, retryAfter },
      true, // Retryable after delay
    );
    this.name = "RateLimitError";
  }
}

// ============================================================================
// ERROR HANDLER
// ============================================================================

export interface ErrorHandler {
  handle(error: Error): void;
  isRetryable(error: Error): boolean;
  shouldEscalate(error: Error): boolean;
}

export class DefaultErrorHandler implements ErrorHandler {
  private escalationCodes = new Set(["AGENT_NOT_FOUND", "INVALID_STATE", "DEPENDENCY_ERROR"]);

  handle(error: Error): void {
    if (error instanceof AGIError) {
      console.error(`[${error.code}] ${error.message}`);
      if (Object.keys(error.context).length > 0) {
        console.error("Context:", error.context);
      }
    } else {
      console.error("[UNKNOWN]", error);
    }
  }

  isRetryable(error: Error): boolean {
    if (error instanceof AGIError) {
      return error.isRetryable;
    }
    // Unknown errors are not retryable by default
    return false;
  }

  shouldEscalate(error: Error): boolean {
    if (error instanceof AGIError) {
      return this.escalationCodes.has(error.code);
    }
    return true; // Unknown errors should be escalated
  }
}

// Global error handler instance
export const errorHandler = new DefaultErrorHandler();

// ============================================================================
// ERROR UTILITIES
// ============================================================================

export function isAGIError(error: Error): error is AGIError {
  return error instanceof AGIError;
}

export function getErrorCode(error: Error): string {
  if (error instanceof AGIError) {
    return error.code;
  }
  return "UNKNOWN";
}

export function wrapError(error: unknown, defaultMessage: string = "Unknown error"): AGIError {
  if (error instanceof AGIError) {
    return error;
  }

  if (error instanceof Error) {
    return new AGIError(
      error.message || defaultMessage,
      "WRAPPED_ERROR",
      { originalError: error.message, stack: error.stack },
      false,
    );
  }

  return new AGIError(
    String(error) || defaultMessage,
    "UNKNOWN_ERROR",
    { originalValue: error },
    false,
  );
}
