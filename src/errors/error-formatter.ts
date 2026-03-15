import chalk from "chalk";
import { type FormattedError } from "./formatted-error.js";
import { ErrorSeverity } from "./error-codes.js";

/**
 * CLI-friendly error formatter with colors and emojis
 */
export class ErrorFormatter {
  /**
   * Get emoji for error severity
   */
  static severityEmoji(severity: ErrorSeverity): string {
    switch (severity) {
      case ErrorSeverity.INFO:
        return "ℹ️";
      case ErrorSeverity.WARN:
        return "⚠️";
      case ErrorSeverity.ERROR:
        return "❌";
      case ErrorSeverity.FATAL:
        return "🔴";
    }
  }

  /**
   * Get color function for severity
   */
  static severityColor(
    severity: ErrorSeverity,
  ): (text: string) => string {
    switch (severity) {
      case ErrorSeverity.INFO:
        return chalk.blue;
      case ErrorSeverity.WARN:
        return chalk.yellow;
      case ErrorSeverity.ERROR:
        return chalk.red;
      case ErrorSeverity.FATAL:
        return chalk.bgRed.white;
    }
  }

  /**
   * Format a FormattedError for CLI display
   * Produces output like:
   * ❌ ERR_AUTH_FAILED
   * 📝 What happened: Description here
   * 💡 How to fix: 1. Step one 2. Step two
   * 🔗 Learn more: https://...
   */
  static formatForDisplay(error: FormattedError): string {
    const lines: string[] = [];
    const colorFn = this.severityColor(error.severity);
    const emoji = this.severityEmoji(error.severity);

    // Error code line
    lines.push(colorFn(`${emoji} ${error.code}`));

    // What happened
    lines.push(chalk.gray("📝 What happened:"));
    lines.push(`  ${error.description}`);

    // How to fix (if available)
    if (error.suggestions.length > 0) {
      lines.push(chalk.gray("💡 How to fix:"));
      error.suggestions.forEach((suggestion, index) => {
        lines.push(`  ${index + 1}. ${suggestion}`);
      });
    }

    // Learn more link (if available)
    if (error.docsUrl) {
      lines.push(chalk.gray("🔗 Learn more:"));
      lines.push(`  ${chalk.blue.underline(error.docsUrl)}`);
    }

    // Additional context if available
    if (error.context?.additionalInfo && Object.keys(error.context.additionalInfo).length > 0) {
      lines.push(chalk.gray("📋 Context:"));
      for (const [key, value] of Object.entries(error.context.additionalInfo)) {
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        lines.push(`  ${key}: ${valueStr}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Format error for structured JSON output
   */
  static formatAsJson(error: FormattedError): Record<string, unknown> {
    return {
      error: {
        code: error.code,
        severity: error.severity,
        message: error.message,
        description: error.description,
        suggestions: error.suggestions,
        docsUrl: error.docsUrl,
        context: error.context,
      },
    };
  }

  /**
   * Format error for logs (single line, verbose)
   */
  static formatForLogs(error: FormattedError): string {
    const parts = [
      `[${error.severity}]`,
      error.code,
      error.message,
    ];

    if (error.suggestions.length > 0) {
      parts.push(`Suggestions: ${error.suggestions.join("; ")}`);
    }

    if (error.cause) {
      const causeMsg = error.cause instanceof Error 
        ? error.cause.message 
        : String(error.cause);
      parts.push(`Caused by: ${causeMsg}`);
    }

    return parts.join(" | ");
  }

  /**
   * Convert unknown error to FormattedError
   */
  static normalizeError(error: unknown): FormattedError {
    if (error instanceof FormattedError) {
      return error;
    }

    if (error instanceof Error) {
      // Try to extract code if it's in the message
      const codeMatch = error.message.match(/^(ERR_\w+):\s*(.*)/);
      if (codeMatch) {
        const [, code, message] = codeMatch;
        return new FormattedError({
          code: (code as any),
          message,
          description: message,
          cause: error,
        });
      }

      return new FormattedError({
        code: "ERR_INTERNAL_ERROR",
        message: error.message,
        description: error.message,
        cause: error,
      });
    }

    return new FormattedError({
      code: "ERR_INTERNAL_ERROR",
      message: "An unknown error occurred",
      description: String(error),
    });
  }

  /**
   * Format multiple errors
   */
  static formatMultipleForDisplay(errors: FormattedError[]): string {
    return errors
      .map((e, i) => {
        const formatted = this.formatForDisplay(e);
        return i > 0 ? `\n${formatted}` : formatted;
      })
      .join("\n");
  }
}
