import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeEnv } from "../runtime.js";

/**
 * Default allowlist of paths where signal-cli is expected to be installed.
 * These are common installation paths across different package managers and platforms.
 */
const SIGNAL_CLI_ALLOWED_PATHS = [
  "/usr/local/bin/signal-cli",
  "/usr/bin/signal-cli",
  "/opt/homebrew/bin/signal-cli",
  "/opt/signal-cli/bin/signal-cli",
  "/home/linuxbrew/.linuxbrew/bin/signal-cli",
];

/**
 * Pattern to detect shell metacharacters and other dangerous characters in paths.
 * These could be used to inject commands if the path is ever passed through a shell.
 */
const SHELL_METACHAR_PATTERN = /[;|&$`'"()<>!\\{}[\]\n\r\t]/;

/**
 * Validates a signal-cli path before spawning to prevent arbitrary binary execution.
 *
 * Security controls:
 * 1. Path must be absolute (prevents PATH manipulation)
 * 2. Path must not contain shell metacharacters (defense in depth)
 * 3. Path must resolve to an allowlisted location after canonicalization
 * 4. Binary must exist and be executable
 *
 * @throws Error if the path fails any validation check
 */
export function validateSignalCliPath(cliPath: string): string {
  const trimmed = cliPath.trim();

  // Reject empty paths
  if (!trimmed) {
    throw new Error("signal-cli path cannot be empty");
  }

  // Reject paths with shell metacharacters (defense in depth)
  if (SHELL_METACHAR_PATTERN.test(trimmed)) {
    throw new Error(`signal-cli path contains invalid characters: ${trimmed}`);
  }

  // Require absolute paths to prevent PATH manipulation attacks
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`signal-cli path must be an absolute path, got: ${trimmed}`);
  }

  // Resolve the path to its canonical form (follows symlinks, resolves ..)
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(trimmed);
  } catch {
    // If realpath fails, the file doesn't exist or isn't accessible
    throw new Error(`signal-cli path does not exist or is not accessible: ${trimmed}`);
  }

  // Check if the canonical path is in the allowlist
  if (!SIGNAL_CLI_ALLOWED_PATHS.includes(canonicalPath)) {
    throw new Error(
      `signal-cli path not in allowlist: ${canonicalPath}\n` +
        `Allowed paths: ${SIGNAL_CLI_ALLOWED_PATHS.join(", ")}`,
    );
  }

  // Verify the file is executable
  try {
    fs.accessSync(canonicalPath, fs.constants.X_OK);
  } catch {
    throw new Error(`signal-cli binary is not executable: ${canonicalPath}`);
  }

  return canonicalPath;
}

export type SignalDaemonOpts = {
  cliPath: string;
  account?: string;
  httpHost: string;
  httpPort: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  runtime?: RuntimeEnv;
};

export type SignalDaemonHandle = {
  pid?: number;
  stop: () => void;
};

export function classifySignalCliLogLine(line: string): "log" | "error" | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  // signal-cli commonly writes all logs to stderr; treat severity explicitly.
  if (/\b(ERROR|WARN|WARNING)\b/.test(trimmed)) {
    return "error";
  }
  // Some signal-cli failures are not tagged with WARN/ERROR but should still be surfaced loudly.
  if (/\b(FAILED|SEVERE|EXCEPTION)\b/i.test(trimmed)) {
    return "error";
  }
  return "log";
}

function buildDaemonArgs(opts: SignalDaemonOpts): string[] {
  const args: string[] = [];
  if (opts.account) {
    args.push("-a", opts.account);
  }
  args.push("daemon");
  args.push("--http", `${opts.httpHost}:${opts.httpPort}`);
  args.push("--no-receive-stdout");

  if (opts.receiveMode) {
    args.push("--receive-mode", opts.receiveMode);
  }
  if (opts.ignoreAttachments) {
    args.push("--ignore-attachments");
  }
  if (opts.ignoreStories) {
    args.push("--ignore-stories");
  }
  if (opts.sendReadReceipts) {
    args.push("--send-read-receipts");
  }

  return args;
}

export function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle {
  // Validate the CLI path before spawning to prevent arbitrary binary execution
  const validatedPath = validateSignalCliPath(opts.cliPath);
  const args = buildDaemonArgs(opts);
  const child = spawn(validatedPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = opts.runtime?.log ?? (() => {});
  const error = opts.runtime?.error ?? (() => {});

  child.stdout?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") {
        log(`signal-cli: ${line.trim()}`);
      } else if (kind === "error") {
        error(`signal-cli: ${line.trim()}`);
      }
    }
  });
  child.stderr?.on("data", (data) => {
    for (const line of data.toString().split(/\r?\n/)) {
      const kind = classifySignalCliLogLine(line);
      if (kind === "log") {
        log(`signal-cli: ${line.trim()}`);
      } else if (kind === "error") {
        error(`signal-cli: ${line.trim()}`);
      }
    }
  });
  child.on("error", (err) => {
    error(`signal-cli spawn error: ${String(err)}`);
  });

  return {
    pid: child.pid ?? undefined,
    stop: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}
