/**
 * Direct import smoke helper for plugin public artifact tests.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveTestBunSourceArgs } from "../../test-utils/bun-process.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const SHARED_IMPORT_ENV = {
  HOME: process.env.HOME,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  NODE_PATH: process.env.NODE_PATH,
  PATH: process.env.PATH,
  TERM: process.env.TERM,
} satisfies NodeJS.ProcessEnv;

export async function runDirectImportSmoke(
  code: string,
  options: { runtime?: "current" | "node" } = {},
): Promise<string> {
  const useNode = options.runtime === "node" || !process.versions.bun;
  // Installed SDK fixtures retain native package resolution without a source tsconfig.
  const runtimeArgs = useNode
    ? ["--import", "tsx"]
    : existsSync(path.join(repoRoot, "tsconfig.json"))
      ? resolveTestBunSourceArgs(repoRoot)
      : [];
  const execPath = options.runtime === "node" ? resolveTestNodeExecPath() : process.execPath;
  const { stdout } = await execFileAsync(execPath, [...runtimeArgs, "-e", code], {
    cwd: repoRoot,
    env: SHARED_IMPORT_ENV,
    timeout: 40_000,
  });

  return stdout;
}
