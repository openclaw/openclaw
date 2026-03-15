import { type CliErrorCode, ErrorSeverity } from "./error-codes.js";

/**
 * Context information that can be included in error messages
 */
export interface ErrorContext {
  command?: string;
  input?: unknown;
  suggestion?: string;
  docsUrl?: string;
  issueUrl?: string;
  additionalInfo?: Record<string, unknown>;
}

/**
 * FormattedError: A user-friendly error with code, context, and recovery suggestions
 */
export class FormattedError extends Error {
  readonly code: CliErrorCode;
  readonly severity: ErrorSeverity;
  readonly description: string;
  readonly suggestions: string[];
  readonly docsUrl?: string;
  readonly issueUrl?: string;
  readonly context?: ErrorContext;
  override readonly cause?: unknown;

  constructor(params: {
    code: CliErrorCode;
    message: string;
    description?: string;
    suggestions?: string[];
    severity?: ErrorSeverity;
    docsUrl?: string;
    issueUrl?: string;
    context?: ErrorContext;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = "FormattedError";
    this.code = params.code;
    this.description = params.description || params.message;
    this.suggestions = params.suggestions || [];
    this.severity = params.severity || ErrorSeverity.ERROR;
    this.docsUrl = params.docsUrl;
    this.issueUrl = params.issueUrl;
    this.context = params.context;
    this.cause = params.cause;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, FormattedError.prototype);
  }

  /**
   * Check if a value is a FormattedError
   */
  static is(value: unknown): value is FormattedError {
    return value instanceof FormattedError;
  }

  /**
   * Get all suggestion texts
   */
  getAllSuggestions(): string[] {
    return this.suggestions;
  }

  /**
   * Get the first suggestion if available
   */
  getPrimarySuggestion(): string | undefined {
    return this.suggestions[0];
  }

  /**
   * Check if this is a fatal error
   */
  isFatal(): boolean {
    return this.severity === ErrorSeverity.FATAL;
  }

  /**
   * Convert to JSON for structured logging
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      description: this.description,
      severity: this.severity,
      suggestions: this.suggestions,
      docsUrl: this.docsUrl,
      issueUrl: this.issueUrl,
      context: this.context,
    };
  }
}

/**
 * Check if an error is a FormattedError
 */
export function isFormattedError(value: unknown): value is FormattedError {
  return value instanceof FormattedError;
}
