/**
 * Sandbox Executor: run code safely in isolated child processes.
 *
 * Perplexity Computer-style code execution capability. The executor:
 * - Supports Python, JavaScript, TypeScript, and shell
 * - Runs each snippet in a temp directory (cleaned up after execution)
 * - Enforces timeouts and output size limits
 * - Returns structured results (stdout, stderr, exit code, duration)
 *
 * Linux note: Full syscall sandboxing (seccomp, namespaces) can be added
 * by wrapping the child process with `firejail` or `nsjail` if installed.
 */

import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runPython } from "./languages/python.js";
import { runJavaScript } from "./languages/javascript.js";

const log = createSubsystemLogger("sandbox/executor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupportedLanguage = "python" | "javascript" | "typescript" | "shell" | "bash";

export type CodeExecutionResult = {
  language: SupportedLanguage;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  success: boolean;
};

export type CodeExecutionOptions = {
  /** Execution timeout in ms (default: 30s) */
  timeoutMs?: number;
  /** Max combined output size in bytes (default: 100 KB) */
  maxOutputBytes?: number;
  /** Optional stdin to pipe to the process */
  stdin?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 100_000;

// ---------------------------------------------------------------------------
// Shell runner
// ---------------------------------------------------------------------------

async function runShell(
  code: string,
  opts: CodeExecutionOptions,
): Promise<CodeExecutionResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  const runId = crypto.randomUUID().slice(0, 8);
  const workDir = path.join(tmpdir(), `openclaw-sandbox-sh-${runId}`);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  const scriptPath = path.join(workDir, "script.sh");
  writeFileSync(scriptPath, `#!/bin/bash\nset -euo pipefail\n${code}`);

  const startedAt = Date.now();
  let timedOut = false;

  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [scriptPath],
      {
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        cwd: workDir,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        if (error?.signal === "SIGTERM" || error?.killed) timedOut = true;

        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // Best-effort
        }

        const exitCode =
          error?.code !== undefined && typeof error.code === "number" ? error.code : 0;

        resolve({
          language: "shell",
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: timedOut ? 124 : exitCode,
          timedOut,
          durationMs,
          success: !timedOut && (error?.code === undefined || error.code === 0),
        });
      },
    );

    child.on("error", (err) => {
      log.warn(`Shell runner error: ${err.message}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute code in the specified language and return structured results.
 */
export async function executeCode(
  code: string,
  language: SupportedLanguage,
  opts: CodeExecutionOptions = {},
): Promise<CodeExecutionResult> {
  log.debug(`Executing ${language} code (${code.length} chars)`);

  switch (language) {
    case "python": {
      const r = await runPython(code, opts);
      return { language, ...r, success: !r.timedOut && r.exitCode === 0 };
    }
    case "javascript": {
      const r = await runJavaScript(code, { ...opts, typescript: false });
      return { language, ...r, success: !r.timedOut && r.exitCode === 0 };
    }
    case "typescript": {
      const r = await runJavaScript(code, { ...opts, typescript: true });
      return { language, ...r, success: !r.timedOut && r.exitCode === 0 };
    }
    case "shell":
    case "bash": {
      return runShell(code, opts);
    }
    default: {
      return {
        language,
        stdout: "",
        stderr: `Unsupported language: ${language}`,
        exitCode: 1,
        timedOut: false,
        durationMs: 0,
        success: false,
      };
    }
  }
}

/**
 * Format execution result as a human-readable string for display.
 */
export function formatExecutionResult(result: CodeExecutionResult): string {
  const parts: string[] = [];

  parts.push(`Language: ${result.language}`);
  parts.push(`Duration: ${result.durationMs}ms`);
  parts.push(`Exit code: ${result.exitCode}`);

  if (result.timedOut) {
    parts.push("Status: TIMED OUT");
  } else if (result.success) {
    parts.push("Status: SUCCESS");
  } else {
    parts.push("Status: FAILED");
  }

  if (result.stdout.trim()) {
    parts.push("", "STDOUT:", result.stdout.trim());
  }
  if (result.stderr.trim()) {
    parts.push("", "STDERR:", result.stderr.trim());
  }

  return parts.join("\n");
}
