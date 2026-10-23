import { getCompileCacheDir } from "node:module";
import path from "node:path";
import process from "node:process";
import { resolveOpenClawCliInvocation, resolveOpenClawCliRespawn } from "../cli-invocation.mjs";
import {
  enableOpenClawCompileCache as enableInstallCompileCache,
  resolveOpenClawCompileCacheDirectory,
  resolveOpenClawCompileCacheRespawnEnv,
} from "../node-compile-cache.mjs";
import { isForegroundGatewayRunArgv } from "./cli/gateway-run-argv.js";
import {
  isForegroundGmailRunArgv,
  isTerminalInteractiveRespawnArgv,
  shouldKeepNativeHookRelayInProcess,
} from "./cli/respawn-policy.js";
import { runRespawnChildWithSignalBridge } from "./process/respawn-child-runner.js";

const COMPILE_CACHE_DISABLED_RESPAWNED_ENV = "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED";

export function resolveEntryInstallRoot(entryFile: string): string {
  const entryDir = path.dirname(entryFile);
  const entryParent = path.basename(entryDir);
  return entryParent === "dist" || entryParent === "src" ? path.dirname(entryDir) : entryDir;
}

function isSourceEntry(currentFile: string): boolean {
  return path.extname(currentFile) === ".ts";
}

function isNodeCompileCacheRequested(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_COMPILE_CACHE !== undefined && env.NODE_DISABLE_COMPILE_CACHE === undefined;
}

export async function respawnWithoutOpenClawCompileCacheIfNeeded(params: {
  currentFile: string;
  env?: NodeJS.ProcessEnv;
  prepareWriteError?: () => Promise<(message: string) => void | Promise<void>>;
}): Promise<boolean> {
  if (!isSourceEntry(params.currentFile) && isForegroundGatewayRunArgv(process.argv)) {
    const env = resolveOpenClawCompileCacheRespawnEnv({
      directory: resolveOpenClawCompileCacheDirectory({
        installRoot: resolveEntryInstallRoot(params.currentFile),
        env: params.env,
        foregroundGateway: true,
      }),
      env: params.env,
      foregroundGateway: true,
    });
    if (env) {
      const { command, args } = resolveOpenClawCliInvocation({ entryPath: params.currentFile });
      if (process.platform !== "win32" && process.execve) {
        process.execve(command, [command, ...args], env);
      }
      const { runRespawnedChild } = await import("../node-runtime-recovery.mjs");
      return runRespawnedChild(resolveOpenClawCliRespawn({ entryPath: params.currentFile, env }));
    }
  }
  const compileCacheDir = getCompileCacheDir?.();
  const env = params.env ?? process.env;
  const argv = process.argv;
  const platform = process.platform;
  // A recovered Unix Gateway must not acquire another short-lived stop wrapper.
  if (platform !== "win32" && isForegroundGatewayRunArgv(argv)) {
    return false;
  }
  if (isForegroundGmailRunArgv(argv) || shouldKeepNativeHookRelayInProcess(argv, platform)) {
    return false;
  }
  if (!isSourceEntry(params.currentFile)) {
    return false;
  }
  if (env[COMPILE_CACHE_DISABLED_RESPAWNED_ENV] === "1") {
    return false;
  }
  if (!compileCacheDir && !isNodeCompileCacheRequested(env)) {
    return false;
  }
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    [COMPILE_CACHE_DISABLED_RESPAWNED_ENV]: "1",
  };
  delete nextEnv.NODE_COMPILE_CACHE;
  const plan = {
    ...resolveOpenClawCliRespawn({
      entryPath: params.currentFile,
      args: argv.slice(2),
      env: nextEnv,
    }),
    detachForProcessTree: platform !== "win32" && !isTerminalInteractiveRespawnArgv(argv),
  };
  const writeError =
    (await params.prepareWriteError?.()) ??
    ((message: string) => {
      process.stderr.write(message);
    });
  process.exitCode = await runRespawnChildWithSignalBridge({
    command: plan.command,
    args: plan.args,
    env: plan.env,
    detachForProcessTree: plan.detachForProcessTree,
    onError: (error) =>
      writeError(
        `[openclaw] Failed to respawn CLI without compile cache: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      ),
  });
  return true;
}

export function enableOpenClawCompileCache(params: {
  currentFile: string;
  installRoot: string;
}): void {
  if (!isSourceEntry(params.currentFile)) {
    enableInstallCompileCache({
      directory: resolveOpenClawCompileCacheDirectory({
        ...params,
        foregroundGateway: isForegroundGatewayRunArgv(process.argv),
      }),
      foregroundGateway: isForegroundGatewayRunArgv(process.argv),
    });
  }
}
