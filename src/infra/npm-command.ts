// Native Node tooling imports this source without a TypeScript resolver.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDependencyEntrypointUrl } from "./runtime-process-dependency-url.ts";
import { runtimeProcessDependencyEntrypoints } from "./runtime-process-manifest.ts";

/** Keep detached, noninteractive npm children away from the installer's /dev/tty on macOS. */
export function resolveNonInteractiveNpmStdin(): { input?: string } {
  // macOS resolves /dev/tty against the child's new session, where tcgetattr fails with EIO.
  // Preserve inherited stdin on other platforms and leave process-tree cleanup intact.
  return process.platform === "darwin" ? { input: "" } : {};
}

/** Runs the packaged npm CLI with the current JavaScript runtime. */
export function resolveBundledNpmCommand(args: readonly string[]): [string, string, ...string[]] {
  let cliPath: string = runtimeProcessDependencyEntrypoints.npm.specifier;
  try {
    const resolvedCliPath = fileURLToPath(
      resolveRuntimeDependencyEntrypointUrl("npm", import.meta.url),
    );
    cliPath = resolvedCliPath;
    if (!fs.statSync(resolvedCliPath).isFile()) {
      throw new Error("Not a regular file");
    }
    return [process.execPath, resolvedCliPath, ...args];
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Bundled npm CLI is missing: ${cliPath}. Reinstall OpenClaw to restore npm/bin/npm-cli.js.`,
        { cause },
      ),
      { code: "BUNDLED_NPM_CLI_NOT_FOUND", name: "BundledNpmCliNotFoundError" },
    );
  }
}

/** Bun must run the packaged CLI directly; npm's executable requires Node. */
export function resolveNpmCommand(args: readonly string[]): [string, ...string[]] {
  return process.versions.bun ? resolveBundledNpmCommand(args) : ["npm", ...args];
}
