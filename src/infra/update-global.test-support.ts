import type { CommandRunner } from "./update-global-command-runner.js";
import { resolveGlobalInstallTarget } from "./update-global.js";

export function commandResult(stdout: string, code = 0) {
  return { stdout, stderr: "", code };
}

export function resolveTarget(
  runCommand: CommandRunner,
  pkgRoot?: string,
  options: Partial<
    Omit<Parameters<typeof resolveGlobalInstallTarget>[0], "runCommand" | "pkgRoot" | "timeoutMs">
  > = {},
) {
  return resolveGlobalInstallTarget({
    manager: "npm",
    runCommand,
    timeoutMs: 1000,
    pkgRoot,
    ...options,
  });
}
