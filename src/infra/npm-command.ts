import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

class BundledNpmCliNotFoundError extends Error {
  readonly code = "BUNDLED_NPM_CLI_NOT_FOUND";

  constructor(cliPath: string, cause?: unknown) {
    super(
      `Bundled npm CLI is missing: ${cliPath}. Reinstall OpenClaw to restore npm/bin/npm-cli.js.`,
      { cause },
    );
    this.name = "BundledNpmCliNotFoundError";
  }
}

/** Runs the packaged npm CLI with the current JavaScript runtime. */
export function resolveBundledNpmCommand(args: readonly string[]): [string, string, ...string[]] {
  let cliPath = "npm/bin/npm-cli.js";
  try {
    cliPath = path.join(path.dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js");
    if (!fs.statSync(cliPath).isFile()) {
      throw new Error("Not a regular file");
    }
  } catch (cause) {
    throw new BundledNpmCliNotFoundError(cliPath, cause);
  }
  return [process.execPath, cliPath, ...args];
}

/** Bun must run the packaged CLI directly; npm's executable requires Node. */
export function resolveNpmCommand(args: readonly string[]): [string, ...string[]] {
  return process.versions.bun ? resolveBundledNpmCommand(args) : ["npm", ...args];
}
