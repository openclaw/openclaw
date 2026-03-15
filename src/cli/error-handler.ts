import chalk from "chalk";
import { isFormattedError } from "../errors/formatted-error.js";
import { ErrorFormatter } from "../errors/error-formatter.js";

/**
 * Global CLI error handler for displaying errors to users
 */
export class CliErrorHandler {
  /**
   * Handle and display an error to the user
   * Returns the exit code to use
   */
  static handleError(error: unknown, options?: { json?: boolean; verbose?: boolean }): number {
    const formattedError = ErrorFormatter.normalizeError(error);

    if (options?.json) {
      // Output structured JSON for programmatic consumption
      console.error(JSON.stringify(ErrorFormatter.formatAsJson(formattedError), null, 2));
    } else {
      // Output human-readable format
      console.error();
      console.error(ErrorFormatter.formatForDisplay(formattedError));
      console.error();
    }

    if (options?.verbose && isFormattedError(error)) {
      // In verbose mode, also output the cause chain
      if (error.cause instanceof Error && error.cause.stack) {
        console.error(chalk.dim("Stack trace:"));
        console.error(chalk.dim(error.cause.stack));
      } else if (error.stack) {
        console.error(chalk.dim("Stack trace:"));
        console.error(chalk.dim(error.stack));
      }
    }

    // Return appropriate exit code based on severity
    if (isFormattedError(error)) {
      return error.isFatal() ? 1 : 1; // Both fatal and error use exit code 1
    }

    return 1;
  }

  /**
   * Wrap a command handler to automatically handle errors
   */
  static wrapCommandHandler(
    handler: (...args: any[]) => Promise<void> | void,
    options?: { json?: boolean; verbose?: boolean },
  ): (...args: any[]) => Promise<void> {
    return async (...args: any[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        const exitCode = this.handleError(error, options);
        process.exit(exitCode);
      }
    };
  }
}

/**
 * Display success message with styling
 */
export function displaySuccess(message: string, indent = ""): void {
  console.log(`${indent}${chalk.green("✓")} ${message}`);
}

/**
 * Display warning with styling
 */
export function displayWarning(message: string, indent = ""): void {
  console.log(`${indent}${chalk.yellow("⚠")} ${message}`);
}

/**
 * Display info message with styling
 */
export function displayInfo(message: string, indent = ""): void {
  console.log(`${indent}${chalk.blue("ℹ")} ${message}`);
}

/**
 * Display error message (for non-FormattedError cases)
 */
export function displayError(message: string, indent = ""): void {
  console.error(`${indent}${chalk.red("✗")} ${message}`);
}
