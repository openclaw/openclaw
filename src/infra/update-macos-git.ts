import { resolveExecutablePath } from "./executable-path.js";
import type { CommandRunner } from "./update-runner-types.js";

export async function describeUnavailableMacosSystemGit(
  runCommand: CommandRunner,
  options: Parameters<CommandRunner>[1],
): Promise<string | null> {
  if (
    process.platform !== "darwin" ||
    resolveExecutablePath("git", { cwd: options.cwd, env: options.env, useCache: false }) !==
      "/usr/bin/git"
  ) {
    return null;
  }
  // Invoking Apple's Git shim without a selected developer directory can open an installer dialog.
  // xcode-select inspects the current selection, including DEVELOPER_DIR and full Xcode installs.
  const selected = await runCommand(["/usr/bin/xcode-select", "--print-path"], options);
  return selected.termination === "exit" && selected.code !== 0
    ? "Update refused: /usr/bin/git requires the macOS developer tools. Install the Command Line Tools with xcode-select --install or select an installed Xcode, then retry openclaw update."
    : null;
}
