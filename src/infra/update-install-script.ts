/**
 * Fallback update method using the official install script.
 * This is more reliable than the complex git/npm update logic.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { runCommandWithTimeout, type CommandOptions } from "../process/exec.js";
import { trimLogTail } from "./restart-sentinel.js";
import type { UpdateRunResult, UpdateStepResult } from "./update-runner.js";

const INSTALL_SCRIPT_URL = "https://openclaw.ai/install.sh";
const DEFAULT_TIMEOUT_MS = 10 * 60_000; // 10 minutes
const MAX_LOG_CHARS = 8000;

type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export type InstallScriptUpdateOptions = {
  timeoutMs?: number;
  runCommand?: CommandRunner;
  channel?: "stable" | "beta" | "dev";
  verbose?: boolean;
};

async function readPackageVersion(root: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function findOpenClawRoot(): Promise<string | null> {
  // Check common locations
  const candidates = [
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, "lib/node_modules/openclaw")
      : null,
    path.join(os.homedir(), ".npm-global/lib/node_modules/openclaw"),
    "/usr/local/lib/node_modules/openclaw",
    "/usr/lib/node_modules/openclaw",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const pkgPath = path.join(candidate, "package.json");
      const raw = await fs.readFile(pkgPath, "utf-8");
      const parsed = JSON.parse(raw) as { name?: string };
      if (parsed?.name === "openclaw") {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Check if required executables exist for the install script method.
 * Returns null if all requirements are met, or an error message if not.
 */
async function checkPrerequisites(
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<string | null> {
  // Check platform - install script only works on Unix-like systems
  if (process.platform === "win32") {
    return "install script method not supported on Windows";
  }

  // Check for bash
  try {
    const bashCheck = await runCommand(["which", "bash"], { timeoutMs: 5000 });
    if (bashCheck.code !== 0) {
      return "bash not found";
    }
  } catch {
    return "bash not found";
  }

  // Check for curl or wget
  try {
    const curlCheck = await runCommand(["which", "curl"], { timeoutMs: 5000 });
    if (curlCheck.code !== 0) {
      const wgetCheck = await runCommand(["which", "wget"], { timeoutMs: 5000 });
      if (wgetCheck.code !== 0) {
        return "neither curl nor wget found";
      }
    }
  } catch {
    return "neither curl nor wget found";
  }

  return null;
}

/**
 * Run update using the official install script.
 * This is a simpler, more reliable fallback when the complex update logic fails.
 */
export async function runInstallScriptUpdate(
  opts: InstallScriptUpdateOptions = {},
): Promise<UpdateRunResult> {
  const startedAt = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const runCommand =
    opts.runCommand ??
    (async (argv, options) => {
      const res = await runCommandWithTimeout(argv, options);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    });

  const steps: UpdateStepResult[] = [];
  const root = await findOpenClawRoot();
  const beforeVersion = root ? await readPackageVersion(root) : null;

  // Check prerequisites before attempting install script
  const prereqError = await checkPrerequisites(runCommand, timeoutMs);
  if (prereqError) {
    return {
      status: "skipped",
      mode: "unknown",
      root: root ?? undefined,
      reason: prereqError,
      before: { version: beforeVersion },
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  // Build install script arguments
  const scriptArgs: string[] = [];
  if (opts.channel === "beta") {
    scriptArgs.push("--beta");
  } else if (opts.channel === "dev") {
    scriptArgs.push("--install-method", "git");
  }
  if (opts.verbose) {
    scriptArgs.push("--verbose");
  }
  // Skip onboarding during update
  scriptArgs.push("--no-onboard");

  // Download and run install script
  const bashCommand = scriptArgs.length > 0
    ? `curl -fsSL "${INSTALL_SCRIPT_URL}" | bash -s -- ${scriptArgs.join(" ")}`
    : `curl -fsSL "${INSTALL_SCRIPT_URL}" | bash`;

  const updateStarted = Date.now();
  let result: { stdout: string; stderr: string; code: number | null };
  try {
    result = await runCommand(["bash", "-c", bashCommand], {
      timeoutMs,
      cwd: os.homedir(),
    });
  } catch (err) {
    // Handle execution errors gracefully
    return {
      status: "error",
      mode: "npm",
      root: root ?? undefined,
      reason: `install script execution failed: ${String(err)}`,
      before: { version: beforeVersion },
      steps: [{
        name: "install script",
        command: bashCommand,
        cwd: os.homedir(),
        durationMs: Date.now() - updateStarted,
        exitCode: null,
        stderrTail: String(err),
      }],
      durationMs: Date.now() - startedAt,
    };
  }
  const updateDuration = Date.now() - updateStarted;

  steps.push({
    name: "install script",
    command: bashCommand,
    cwd: os.homedir(),
    durationMs: updateDuration,
    exitCode: result.code,
    stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
    stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS),
  });

  const afterRoot = await findOpenClawRoot();
  const afterVersion = afterRoot ? await readPackageVersion(afterRoot) : null;

  return {
    status: result.code === 0 ? "ok" : "error",
    mode: "npm", // Install script uses npm
    root: afterRoot ?? root ?? undefined,
    reason: result.code === 0 ? undefined : "install-script-failed",
    before: { version: beforeVersion },
    after: { version: afterVersion },
    steps,
    durationMs: Date.now() - startedAt,
  };
}
