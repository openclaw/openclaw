/**
 * Safe wrapper for process.cwd() that handles uv_cwd error when directory is deleted.
 */

/**
 * Get cwd, exit with error message if it fails.
 * Use when cwd is required (run-main, dotenv).
 */
export function safeProcessCwd(): string {
  try {
    return process.cwd();
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("uv_cwd")
        ? "Current working directory has been deleted. Please cd to a valid directory before running openclaw."
        : `Failed to resolve current working directory: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[openclaw] Error: ${message}`);
    process.exit(1);
  }
}

/**
 * Get cwd, return undefined if it fails.
 * Use when cwd is optional (skills-cli).
 */
export function safeProcessCwdOptional(): string | undefined {
  try {
    return process.cwd();
  } catch {
    // If cwd is deleted, uv_cwd throws. Return undefined to use default.
    return undefined;
  }
}
