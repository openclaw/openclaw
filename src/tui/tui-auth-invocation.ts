import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  buildWindowsCmdExeCommandLine,
  isWindowsBatchCommand,
  resolveTrustedWindowsCmdExe,
} from "../process/windows-command.js";

const CODEX_CLI_LOOKUP_TIMEOUT_MS = 5_000;

/** Resolve the absolute path to the `codex` CLI binary, or `null` if not installed. */
export async function resolveCodexCliBin(): Promise<string | null> {
  if (process.platform === "win32") {
    const pathEnv = process.env.PATH ?? process.env.Path ?? "";
    // Prefer npm's runnable PATHEXT launcher, but retain bare-only native installs.
    return (
      resolveExecutableFromPathEnv("codex", pathEnv, process.env, {
        includeExtensionless: false,
      }) ??
      resolveExecutableFromPathEnv("codex", pathEnv, process.env, {
        includeExtensionless: true,
      }) ??
      null
    );
  }
  try {
    const result = await runCommandWithTimeout(["which", "codex"], {
      killSignal: "SIGKILL",
      maxOutputBytes: 64 * 1024,
      timeoutMs: CODEX_CLI_LOOKUP_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.termination !== "exit") {
      return null;
    }
    return result.stdout.trim().split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function resolveLocalAuthSpawnInvocation(params: { command: string; args: string[] }): {
  args: string[];
  command: string;
  options: { windowsHide?: true; windowsVerbatimArguments?: true };
} {
  const platform = process.platform;
  if (!isWindowsBatchCommand(params.command.trim(), platform)) {
    return { command: params.command, args: params.args, options: {} };
  }
  return {
    command: resolveTrustedWindowsCmdExe(platform),
    args: ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(params.command, params.args)],
    options: { windowsHide: true, windowsVerbatimArguments: true },
  };
}
