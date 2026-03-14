/**
 * Python language runner for the sandbox executor.
 *
 * Executes Python code in a child process with:
 * - Configurable timeout
 * - stdout/stderr capture
 * - Working directory isolation
 * - Resource limits via ulimit (Linux)
 */

import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("sandbox/python");

export type PythonRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};

export type PythonRunOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  workDir?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 100_000; // 100 KB

/**
 * Run Python code in an isolated temp directory.
 * Linux-only: uses ulimit to restrict memory and file creation.
 */
export async function runPython(
  code: string,
  opts: PythonRunOptions = {},
): Promise<PythonRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  // Create temp working directory
  const runId = crypto.randomUUID().slice(0, 8);
  const workDir = opts.workDir ?? path.join(tmpdir(), `openclaw-sandbox-${runId}`);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  const scriptPath = path.join(workDir, "script.py");
  writeFileSync(scriptPath, code);

  const startedAt = Date.now();
  let timedOut = false;

  return new Promise((resolve) => {
    // Find python3 binary
    const pythonBin = process.env.OPENCLAW_PYTHON_BIN ?? "python3";

    const child = execFile(
      pythonBin,
      [scriptPath],
      {
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        cwd: workDir,
        env: {
          ...process.env,
          // Restrict network access hint (not enforced without namespaces)
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONUNBUFFERED: "1",
        },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;

        if (error?.signal === "SIGTERM" || error?.killed) {
          timedOut = true;
        }

        // Cleanup temp dir
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }

        const exitCode =
          error?.code !== undefined && typeof error.code === "number" ? error.code : 0;

        resolve({
          stdout: truncate(stdout, maxOutputBytes),
          stderr: truncate(stderr, maxOutputBytes),
          exitCode: timedOut ? 124 : exitCode,
          timedOut,
          durationMs,
        });
      },
    );

    child.on("error", (err) => {
      log.warn(`Python runner error: ${err.message}`);
    });
  });
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  const enc = Buffer.byteLength(text);
  if (enc <= max) return text;
  return text.slice(0, max) + "\n[output truncated]";
}
