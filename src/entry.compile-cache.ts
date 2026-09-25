// Manages compile-cache respawn behavior for the CLI entrypoint.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { getCompileCacheDir } from "node:module";
import path from "node:path";
import process from "node:process";
import { resolveOpenClawCompileCacheDirectory } from "../node-compile-cache.mjs";
import { isForegroundGatewayRunArgv } from "./cli/gateway-run-argv.js";
import {
  isForegroundGmailRunArgv,
  isTerminalInteractiveRespawnArgv,
  shouldKeepNativeHookRelayInProcess,
} from "./cli/respawn-policy.js";
import { enableOwnedNodeCompileCache } from "./infra/node-compile-cache-env.js";
import { attachChildProcessBridge } from "./process/child-process-bridge.js";
import {
  runRespawnChildWithSignalBridge,
  type RespawnChildRuntime,
} from "./process/respawn-child-runner.js";

const COMPILE_CACHE_DISABLED_RESPAWNED_ENV = "OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED";

export function resolveEntryInstallRoot(entryFile: string): string {
  const entryDir = path.dirname(entryFile);
  const entryParent = path.basename(entryDir);
  return entryParent === "dist" || entryParent === "src" ? path.dirname(entryDir) : entryDir;
}

function isSourceCheckoutInstallRoot(installRoot: string): boolean {
  return (
    existsSync(path.join(installRoot, ".git")) ||
    existsSync(path.join(installRoot, "src", "entry.ts"))
  );
}

function isNodeCompileCacheDisabled(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_DISABLE_COMPILE_CACHE !== undefined;
}

function isNodeCompileCacheRequested(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_COMPILE_CACHE !== undefined && !isNodeCompileCacheDisabled(env);
}

function shouldEnableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): boolean {
  return (
    !isNodeCompileCacheDisabled(params.env ?? process.env) &&
    !isSourceCheckoutInstallRoot(params.installRoot)
  );
}

type OpenClawCompileCacheRespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  detachForProcessTree: boolean;
};

type OpenClawCompileCacheRespawnRuntime = RespawnChildRuntime & {
  writeError: (message: string) => void | Promise<void>;
};

function buildOpenClawCompileCacheRespawnPlan(params: {
  currentFile: string;
  installRoot: string;
  compileCacheDir?: string;
  env?: NodeJS.ProcessEnv;
}): OpenClawCompileCacheRespawnPlan | undefined {
  const env = params.env ?? process.env;
  const argv = process.argv;
  const platform = process.platform;
  // A recovered Unix Gateway must not acquire another short-lived stop wrapper.
  if (platform !== "win32" && isForegroundGatewayRunArgv(argv)) {
    return undefined;
  }
  if (isForegroundGmailRunArgv(argv) || shouldKeepNativeHookRelayInProcess(argv, platform)) {
    return undefined;
  }
  if (!isSourceCheckoutInstallRoot(params.installRoot)) {
    return undefined;
  }
  if (env[COMPILE_CACHE_DISABLED_RESPAWNED_ENV] === "1") {
    return undefined;
  }
  if (!params.compileCacheDir && !isNodeCompileCacheRequested(env)) {
    return undefined;
  }
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    [COMPILE_CACHE_DISABLED_RESPAWNED_ENV]: "1",
  };
  delete nextEnv.NODE_COMPILE_CACHE;
  return {
    command: process.execPath,
    args: [...process.execArgv, params.currentFile, ...argv.slice(2)],
    env: nextEnv,
    detachForProcessTree: platform !== "win32" && !isTerminalInteractiveRespawnArgv(argv),
  };
}

export async function respawnWithoutOpenClawCompileCacheIfNeeded(params: {
  currentFile: string;
  installRoot: string;
  env?: NodeJS.ProcessEnv;
  prepareWriteError?: () => Promise<(message: string) => void | Promise<void>>;
}): Promise<boolean> {
  const plan = buildOpenClawCompileCacheRespawnPlan({
    currentFile: params.currentFile,
    installRoot: params.installRoot,
    compileCacheDir: getCompileCacheDir?.(),
    env: params.env,
  });
  if (!plan) {
    return false;
  }
  const writeError = await params.prepareWriteError?.();
  runOpenClawCompileCacheRespawnPlan(
    plan,
    writeError
      ? {
          spawn,
          attachChildProcessBridge,
          exit: process.exit.bind(process) as (code?: number) => never,
          writeError,
        }
      : undefined,
  );
  return true;
}

function runOpenClawCompileCacheRespawnPlan(
  plan: OpenClawCompileCacheRespawnPlan,
  runtime: OpenClawCompileCacheRespawnRuntime = {
    spawn,
    attachChildProcessBridge,
    exit: process.exit.bind(process) as (code?: number) => never,
    writeError: (message: string) => {
      process.stderr.write(message);
    },
  },
): ChildProcess {
  return runRespawnChildWithSignalBridge({
    command: plan.command,
    args: plan.args,
    env: plan.env,
    detachForProcessTree: plan.detachForProcessTree,
    runtime,
    onError: (error) => {
      return runtime.writeError(
        `[openclaw] Failed to respawn CLI without compile cache: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }\n`,
      );
    },
  });
}

export function enableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): void {
  if (!shouldEnableOpenClawCompileCache(params)) {
    return;
  }
  try {
    const directory = resolveOpenClawCompileCacheDirectory(params);
    enableOwnedNodeCompileCache(directory);
  } catch {
    // Best-effort only; never block startup.
  }
}
