/**
 * JavaScript/Node.js language runner for the sandbox executor.
 *
 * Runs JS/TS code using Node.js with:
 * - Configurable timeout
 * - stdout/stderr capture
 * - Temp directory isolation
 * - TypeScript support via tsx (if available)
 */

import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("sandbox/javascript");

export type JsRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};

export type JsRunOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Use TypeScript (via tsx) instead of plain Node */
  typescript?: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 100_000;

/**
 * Run JavaScript (or TypeScript) code in an isolated child process.
 */
export async function runJavaScript(
  code: string,
  opts: JsRunOptions = {},
): Promise<JsRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const isTs = opts.typescript ?? false;

  const runId = crypto.randomUUID().slice(0, 8);
  const workDir = path.join(tmpdir(), `openclaw-sandbox-js-${runId}`);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  const ext = isTs ? "ts" : "js";
  const scriptPath = path.join(workDir, `script.${ext}`);
  writeFileSync(scriptPath, code);

  const startedAt = Date.now();
  let timedOut = false;

  // Resolve runner binary
  const runner = isTs ? (process.env.OPENCLAW_TSX_BIN ?? "tsx") : "node";

  return new Promise((resolve) => {
    const child = execFile(
      runner,
      [scriptPath],
      {
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        cwd: workDir,
        env: {
          ...process.env,
          NODE_ENV: "sandbox",
        },
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;

        if (error?.signal === "SIGTERM" || error?.killed) {
          timedOut = true;
        }

        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // Best-effort
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
      log.warn(`JS runner error: ${err.message}`);
    });
  });
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  const enc = Buffer.byteLength(text);
  if (enc <= max) return text;
  return text.slice(0, max) + "\n[output truncated]";
}
