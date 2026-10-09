// Owns dotenv file selection separately from dotenv parsing and mutation.
import os from "node:os";
import path from "node:path";
import { resolveConfigDir } from "./config-dir.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { tryProcessCwd } from "./safe-cwd.js";

type DotEnvPathOptions = {
  additionalEnvPaths?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateEnvPath?: string;
};

export function resolveWorkspaceDotEnvPath(options: { cwd?: string } = {}): string | null {
  const cwd = Object.hasOwn(options, "cwd") ? options.cwd : tryProcessCwd();
  return cwd ? path.join(cwd, ".env") : null;
}

export function resolveGlobalRuntimeDotEnvPaths(options: DotEnvPathOptions = {}): {
  gatewayEnvPath: string | null;
  globalEnvPaths: string[];
} {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir;
  const stateEnvPath = options.stateEnvPath ?? path.join(resolveConfigDir(env, homedir), ".env");
  const globalEnvPaths = [...new Set([stateEnvPath, ...(options.additionalEnvPaths ?? [])])];
  const defaultStateEnvPath = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw", ".env");
  const hasExplicitNonDefaultStateDir =
    env.OPENCLAW_STATE_DIR?.trim() !== undefined &&
    path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath);
  return {
    globalEnvPaths,
    gatewayEnvPath: hasExplicitNonDefaultStateDir
      ? null
      : path.join(resolveRequiredHomeDir(env, homedir), ".config", "openclaw", "gateway.env"),
  };
}

/** Lists every dotenv file the normal config read could consult. */
export function resolveConfigReadDotEnvPaths(options: DotEnvPathOptions = {}): string[] {
  const workspaceEnvPath = resolveWorkspaceDotEnvPath(options);
  const { gatewayEnvPath, globalEnvPaths } = resolveGlobalRuntimeDotEnvPaths(options);
  return [workspaceEnvPath, ...globalEnvPaths, gatewayEnvPath].filter(
    (filePath): filePath is string => filePath !== null,
  );
}
