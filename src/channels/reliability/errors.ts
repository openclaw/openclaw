/**
 * Structured error codes for channel operations.
 *
 * Provides consistent error handling across all channel adapters.
 */

export enum ChannelErrorCode {
  /** Network timeout during operation */
  NETWORK_TIMEOUT = "NETWORK_TIMEOUT",
  /** Rate limited by provider */
  RATE_LIMITED = "RATE_LIMITED",
  /** Authentication expired or invalid */
  AUTH_EXPIRED = "AUTH_EXPIRED",
  /** Message exceeds size limits */
  MESSAGE_TOO_LARGE = "MESSAGE_TOO_LARGE",
  /** Channel/conversation not found or unavailable */
  CHANNEL_UNAVAILABLE = "CHANNEL_UNAVAILABLE",
  /** Duplicate message (idempotency conflict) */
  IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT",
  /** User blocked or conversation closed */
  USER_BLOCKED = "USER_BLOCKED",
  /** Invalid message format or content */
  INVALID_CONTENT = "INVALID_CONTENT",
  /** Provider API error */
  PROVIDER_ERROR = "PROVIDER_ERROR",
  /** Unknown/unexpected error */
  UNKNOWN = "UNKNOWN",
}

/** Error codes that are typically recoverable with retry */
export const RECOVERABLE_ERROR_CODES = new Set<ChannelErrorCode>([
  ChannelErrorCode.NETWORK_TIMEOUT,
  ChannelErrorCode.RATE_LIMITED,
  ChannelErrorCode.PROVIDER_ERROR,
]);

/** Error codes that require user intervention */
export const PERMANENT_ERROR_CODES = new Set<ChannelErrorCode>([
  ChannelErrorCode.AUTH_EXPIRED,
  ChannelErrorCode.USER_BLOCKED,
  ChannelErrorCode.CHANNEL_UNAVAILABLE,
  ChannelErrorCode.INVALID_CONTENT,
  ChannelErrorCode.MESSAGE_TOO_LARGE,
]);

export interface ChannelErrorOptions {
  /** Original error that caused this */
  cause?: unknown;
  /** Additional context for debugging */
  context?: Record<string, unknown>;
  /** Suggested retry delay in ms (for rate limits) */
  retryAfterMs?: number;
}

/**
 * Structured error for channel operations.
 */
export class ChannelError extends Error {
  readonly code: ChannelErrorCode;
  readonly correlationId: string;
  readonly channel: string;
  readonly recoverable: boolean;
  readonly retryAfterMs?: number;
  readonly context?: Record<string, unknown>;

  constructor(
    code: ChannelErrorCode,
    message: string,
    correlationId: string,
    channel: string,
    options: ChannelErrorOptions = {},
  ) {
    super(message);
    this.name = "ChannelError";
    this.code = code;
    this.correlationId = correlationId;
    this.channel = channel;
    this.recoverable = RECOVERABLE_ERROR_CODES.has(code);
    this.retryAfterMs = options.retryAfterMs;
    this.context = options.context;

    if (options.cause) {
      this.cause = options.cause;
    }

    // Maintains proper stack trace in V8 (Node.js/Chrome)
    const ErrorWithCapture = Error as unknown as {
      captureStackTrace?: (err: Error, constructor: Function) => void;
    };
    ErrorWithCapture.captureStackTrace?.(this, ChannelError);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      correlationId: this.correlationId,
      channel: this.channel,
      recoverable: this.recoverable,
      retryAfterMs: this.retryAfterMs,
      context: this.context,
    };
  }
}

/**
 * Check if an error is a ChannelError.
 */
export function isChannelError(err: unknown): err is ChannelError {
  return err instanceof ChannelError;
}

/**
 * Check if an error is recoverable (suitable for retry).
 */
export function isRecoverableChannelError(err: unknown): boolean {
  if (isChannelError(err)) {
    return err.recoverable;
  }
  return false;
}

/**
 * Wrap an unknown error as a ChannelError.
 */
export function wrapAsChannelError(
  err: unknown,
  correlationId: string,
  channel: string,
  defaultCode = ChannelErrorCode.UNKNOWN,
): ChannelError {
  if (isChannelError(err)) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  return new ChannelError(defaultCode, message, correlationId, channel, { cause: err });
}

/**
 * Common error code detection from provider errors.
 */
export function detectErrorCode(err: unknown): ChannelErrorCode {
  if (!err || typeof err !== "object") {
    return ChannelErrorCode.UNKNOWN;
  }

  const errorObj = err as { code?: string; status?: number; message?: string };
  const code = errorObj.code?.toUpperCase() ?? "";
  const status = errorObj.status ?? 0;
  const message = (errorObj.message ?? "").toLowerCase();

  // Network errors
  if (
    code.includes("TIMEOUT") ||
    code.includes("ECONNRESET") ||
    code.includes("ETIMEDOUT") ||
    message.includes("timeout")
  ) {
    return ChannelErrorCode.NETWORK_TIMEOUT;
  }

  // Rate limits (HTTP 429)
  if (status === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return ChannelErrorCode.RATE_LIMITED;
  }

  // Auth errors (HTTP 401, 403)
  if (status === 401 || status === 403 || message.includes("unauthorized")) {
    return ChannelErrorCode.AUTH_EXPIRED;
  }

  // Not found (HTTP 404)
  if (status === 404 || message.includes("not found")) {
    return ChannelErrorCode.CHANNEL_UNAVAILABLE;
  }

  // Payload too large (HTTP 413)
  if (status === 413 || message.includes("too large")) {
    return ChannelErrorCode.MESSAGE_TOO_LARGE;
  }

  // Provider errors (HTTP 5xx)
  if (status >= 500) {
    return ChannelErrorCode.PROVIDER_ERROR;
  }

  return ChannelErrorCode.UNKNOWN;
}
