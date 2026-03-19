/**
 * Sandbox-invoke: when running `openclaw tui` or `openclaw onboard` (or opencli equivalents)
 * from the host, automatically connect to the NemoClaw/OpenShell sandbox and run the
 * command inside it so the sandbox environment is used.
 *
 * Detection: /sandbox/.openclaw or /sandbox/.nemoclaw indicates we're already inside.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_SANDBOX_NAME = "openclaw";

function isInsideSandbox(): boolean {
  return existsSync("/sandbox/.openclaw") || existsSync("/sandbox/.nemoclaw");
}

function getSandboxName(): string {
  const home = process.env.HOME ?? "/tmp";
  const statePath = join(home, ".nemoclaw", "state", "nemoclaw.json");
  if (!existsSync(statePath)) {
    return DEFAULT_SANDBOX_NAME;
  }
  try {
    const data = JSON.parse(readFileSync(statePath, "utf-8")) as { sandboxName?: string };
    return typeof data.sandboxName === "string" && data.sandboxName.length > 0
      ? data.sandboxName
      : DEFAULT_SANDBOX_NAME;
  } catch {
    return DEFAULT_SANDBOX_NAME;
  }
}

function isSandboxRunning(sandboxName: string): boolean {
  try {
    const result = spawnSync("openshell", ["sandbox", "status", sandboxName, "--json"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status !== 0 || !result.stdout) {
      return false;
    }
    const parsed = JSON.parse(result.stdout) as { state?: string };
    return parsed.state === "running";
  } catch {
    return false;
  }
}

/**
 * If we're on the host (not inside sandbox) and the sandbox is running,
 * exec into the sandbox with the given CLI command. Does not return.
 *
 * @param cliName - e.g. "openclaw" or "opencli"
 * @param args - e.g. ["tui", "--url", "ws://..."] or ["onboard"]
 * @returns true if we invoked (process replaced); false if caller should proceed normally
 */
export function tryInvokeInSandbox(cliName: string, args: string[]): boolean {
  if (isInsideSandbox()) {
    return false;
  }
  const sandboxName = getSandboxName();
  if (!isSandboxRunning(sandboxName)) {
    return false;
  }
  const fullArgs = ["sandbox", "connect", sandboxName, "--", cliName, ...args];
  const result = spawnSync("openshell", fullArgs, {
    stdio: "inherit",
    encoding: "utf-8",
  });
  process.exit(result.status ?? 1);
}

/**
 * When on the host and the NemoClaw/OpenShell sandbox is running, exec into the
 * sandbox and run the command there. Otherwise proceed normally (inside sandbox
 * or sandbox not available).
 */
export function requireSandboxOrInvoke(cliName: string, args: string[]): void {
  if (isInsideSandbox()) {
    return;
  }
  const sandboxName = getSandboxName();
  if (!isSandboxRunning(sandboxName)) {
    return; // Run on host when sandbox not available
  }
  const fullArgs = ["sandbox", "connect", sandboxName, "--", cliName, ...args];
  const result = spawnSync("openshell", fullArgs, {
    stdio: "inherit",
    encoding: "utf-8",
  });
  process.exit(result.status ?? 1);
}
