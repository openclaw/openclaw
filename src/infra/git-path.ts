import fs from "node:fs";
import path from "node:path";
import { createCommandError } from "../process/command-error.js";
import { resolveCommandEnv } from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout, type CommandOptions } from "../process/exec.js";
import { resolveSafeChildProcessInvocation } from "../process/windows-command.js";

/** Convert a Git filesystem-path field before native filesystem access. */
export async function resolveGitPath(
  value: string,
  options: Pick<CommandOptions, "baseEnv" | "env" | "cwd" | "timeoutMs" | "signal"> = {},
): Promise<string> {
  if (process.platform !== "win32" || !value.startsWith("/") || value.startsWith("//")) {
    return value;
  }
  // MSYS/Cygwin mounts belong to the selected Git installation. A drive-letter
  // rewrite misses custom mounts; a PATH lookup can select another cygpath.
  const invocation = resolveSafeChildProcessInvocation({
    argv: ["git"],
    cwd: options.cwd,
    env: resolveCommandEnv({ argv: ["git"], baseEnv: options.baseEnv, env: options.env }),
  });
  const directory = path.win32.dirname(invocation.command);
  // Native Git can also emit drive-rooted /paths (for example attributesFile).
  // Only the MSYS/Cygwin installation layout gives those paths POSIX semantics.
  if (
    invocation.usesWindowsExitCodeShim ||
    !["msys-2.0.dll", "cygwin1.dll"].some((dll) => fs.existsSync(path.win32.join(directory, dll)))
  ) {
    return value;
  }
  const converter = path.win32.join(directory, "cygpath.exe");
  const result = await runUtf8CommandWithTimeout([converter, "-w", "-C", "UTF8", "--", value], {
    ...options,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
  if (result.code !== 0) {
    throw createCommandError("cygpath", result, { timeoutMs: options.timeoutMs ?? 10_000 });
  }
  // Remove only the converter's line ending, preserving porcelain path spaces.
  return result.stdout.replace(/\r?\n$/, "");
}
