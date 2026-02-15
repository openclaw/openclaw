/**
 * Cron pre-check gate: execute a lightweight shell command before an agent turn.
 *
 * If the command exits 0 with non-empty stdout → job proceeds (stdout available as context).
 * If the command exits non-zero or stdout is empty → job is skipped (no tokens spent).
 *
 * This saves tokens on recurring jobs that only need attention when something changed
 * (e.g., new PRs, new emails, file changes, API status changes).
 */

import { exec } from "node:child_process";
import type { CronPreCheck } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_BYTES = 32_768; // 32 KB — enough context without overwhelming the prompt

export type PreCheckResult = { passed: true; output: string } | { passed: false; reason: string };

/**
 * Run a pre-check command. Returns `passed: true` with stdout if the gate
 * passes, or `passed: false` with a reason if it should be skipped.
 */
export function runPreCheck(
  preCheck: CronPreCheck,
  opts?: { cwd?: string },
): Promise<PreCheckResult> {
  const timeoutMs = (preCheck.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1_000;

  return new Promise((resolve) => {
    const child = exec(preCheck.command, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      cwd: opts?.cwd,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      resolve({ passed: false, reason: `preCheck error: ${err.message}` });
    });

    child.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        resolve({
          passed: false,
          reason: `preCheck timed out after ${preCheck.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}s`,
        });
        return;
      }

      if (code !== 0) {
        const hint = stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 200)})` : "";
        resolve({ passed: false, reason: `preCheck exited with code ${code}${hint}` });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({ passed: false, reason: "preCheck produced empty output (nothing to do)" });
        return;
      }

      // Truncate if needed
      const output =
        trimmed.length > MAX_OUTPUT_BYTES
          ? trimmed.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]"
          : trimmed;

      resolve({ passed: true, output });
    });
  });
}

/**
 * Apply the pre-check output to a payload message/text based on the outputMode.
 */
export function applyPreCheckOutput(
  originalText: string,
  preCheckOutput: string,
  outputMode: CronPreCheck["outputMode"],
): string {
  switch (outputMode ?? "prepend") {
    case "replace":
      return preCheckOutput;
    case "ignore":
      return originalText;
    case "prepend":
    default:
      return `[Pre-check context]\n${preCheckOutput}\n\n${originalText}`;
  }
}
