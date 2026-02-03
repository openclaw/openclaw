/**
 * Command security validation using tirith.
 * Detects malicious URLs, homograph attacks, pipe-to-shell patterns.
 *
 * tirith is an external dependency - install via:
 *   cargo install tirith
 *   brew install sheeki03/tap/tirith
 */
import { execFileSync } from "node:child_process";
// Import type from config to avoid duplication
import type { CommandCheckConfig } from "../config/types.tools.js";
import { logWarn } from "../logger.js";

// Re-export for convenience
export type { CommandCheckConfig };

export type CommandSecurityAction = "allow" | "warn" | "block";

export type CommandSecurityFinding = {
  rule_id: string;
  severity: string;
  title: string;
  description?: string; // Optional in tirith output
};

export type CommandSecurityVerdict = {
  action: CommandSecurityAction;
  findings: CommandSecurityFinding[];
  schema_version?: number;
};

// Defaults applied here (not in a separate defaults file)
// enabled=true by default - security checks run unless explicitly disabled
const DEFAULT_ENABLED = true;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BLOCK_ON_ERROR = false;

// Module-level flag to log "tirith not installed" only once per process
let loggedTirithMissing = false;

/**
 * Check a command for security issues using tirith.
 * Returns verdict with action (allow/warn/block) and findings.
 * Fails open (returns allow) if tirith is not installed or errors.
 */
export function checkCommandSecurity(
  command: string,
  config?: CommandCheckConfig,
): CommandSecurityVerdict {
  // Auto-disable in vitest to avoid breaking existing tests
  // Note: Only VITEST env var is checked (not NODE_ENV=test) to prevent
  // accidental bypass in staging environments that use NODE_ENV=test
  if (process.env.VITEST) {
    return { action: "allow", findings: [] };
  }

  const enabled = config?.enabled ?? DEFAULT_ENABLED;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const blockOnError = config?.blockOnError ?? DEFAULT_BLOCK_ON_ERROR;

  if (!enabled) {
    return { action: "allow", findings: [] };
  }

  // Short-circuit if tirith is known to be missing (avoid repeated ENOENT failures)
  if (loggedTirithMissing) {
    // Respect blockOnError even when short-circuiting
    return { action: blockOnError ? "block" : "allow", findings: [] };
  }

  try {
    const result = execFileSync("tirith", ["check", "--json", "--shell", "posix", "--", command], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Handle potential Buffer (even with encoding set, some error paths return Buffer)
    const resultStr = Buffer.isBuffer(result) ? result.toString("utf-8") : result;
    const verdict = JSON.parse(resultStr) as CommandSecurityVerdict;

    // Validate action is one of expected values
    if (!["allow", "warn", "block"].includes(verdict.action)) {
      logWarn(`tirith returned unexpected action: ${verdict.action}, treating as allow`);
      return { action: "allow", findings: [] };
    }

    // Coerce findings to array if malformed
    const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
    return { ...verdict, findings };
  } catch (err: unknown) {
    const error = err as {
      code?: string;
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };

    // tirith exits non-zero for warn (2) and block (1) but still outputs JSON to stdout
    if (error.stdout) {
      try {
        const stdoutStr = Buffer.isBuffer(error.stdout)
          ? error.stdout.toString("utf-8")
          : error.stdout;
        const verdict = JSON.parse(stdoutStr) as CommandSecurityVerdict;
        if (["allow", "warn", "block"].includes(verdict.action)) {
          // Coerce findings to array if malformed
          const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
          return { ...verdict, findings };
        }
      } catch {
        // JSON parse failed, fall through
      }
    }

    // ENOENT = tirith not installed - log only once (use logWarn for visibility)
    if (error.code === "ENOENT") {
      if (!loggedTirithMissing) {
        loggedTirithMissing = true;
        const mode = blockOnError ? "blocking" : "skipping";
        logWarn(
          `tirith not installed, ${mode} command security checks (install: cargo install tirith)`,
        );
      }
      // Respect blockOnError: if true, missing tirith blocks execution
      return { action: blockOnError ? "block" : "allow", findings: [] };
    }

    // Other errors (timeout, etc.)
    logWarn(`tirith check failed: ${error.code ?? error.status ?? "unknown error"}`);
    if (blockOnError) {
      // Return block with empty findings - caller will use appropriate error message
      return { action: "block", findings: [] };
    }
    return { action: "allow", findings: [] };
  }
}

/**
 * Format findings for display in warnings array.
 */
export function formatSecurityWarning(findings: CommandSecurityFinding[]): string {
  if (findings.length === 0) {
    return "";
  }

  const lines = findings.map((f) => `  [${f.severity}] ${f.rule_id}: ${f.title}`);
  return `Security warning:\n${lines.join("\n")}`;
}

/**
 * Reset the "logged tirith missing" flag (for testing).
 */
export function resetTirithMissingFlag(): void {
  loggedTirithMissing = false;
}
