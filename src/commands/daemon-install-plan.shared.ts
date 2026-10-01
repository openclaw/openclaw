import fs from "node:fs";
import path from "node:path";
import {
  resolveBunRuntimeInfo,
  resolvePinnedDaemonRuntimePath,
  resolvePreferredBunPath,
  resolvePreferredNodePath,
} from "../daemon/runtime-paths.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export type GatewayInstallPlan = {
  runtime: GatewayDaemonRuntime;
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
};

function resolveGatewayDevMode(argv: string[] = process.argv): boolean {
  const entry = argv[1];
  const normalizedEntry = entry?.replaceAll("\\", "/");
  return (
    normalizedEntry !== undefined &&
    normalizedEntry.includes("/src/") &&
    normalizedEntry.endsWith(".ts")
  );
}

/** Use the running Bun only when implicit Node discovery found no supported runtime. */
export async function resolveRunningBunFallback(params: {
  env: Record<string, string | undefined>;
  /** Null carries an already completed discovery with no supported Node. */
  nodePath?: string | null;
}): Promise<string | undefined> {
  if (!process.versions.bun) {
    return undefined;
  }
  const nodePath =
    params.nodePath === undefined
      ? await resolvePreferredNodePath({ env: params.env, runtime: "node" })
      : params.nodePath;
  if (
    nodePath ||
    (await resolveBunRuntimeInfo(process.execPath, undefined, params.env)).status !== "supported"
  ) {
    return undefined;
  }
  return process.execPath;
}

export async function resolveDaemonInstallRuntimeInputs(params: {
  env: Record<string, string | undefined>;
  runtime: GatewayDaemonRuntime;
  runtimeExplicit?: boolean;
  devMode?: boolean;
  runtimePath?: string;
  pinnedRuntimePath?: string;
  wrapperPath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<{ devMode: boolean; runtime: GatewayDaemonRuntime; runtimePath?: string }> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  if (params.wrapperPath?.trim()) {
    return { devMode, runtime: params.runtime, runtimePath: params.runtimePath };
  }
  const pinnedRuntimePath =
    params.pinnedRuntimePath === undefined
      ? undefined
      : await resolvePinnedDaemonRuntimePath(params.pinnedRuntimePath, params.runtime, params.env);
  const runtimePath =
    pinnedRuntimePath ??
    params.runtimePath ??
    (params.runtime === "bun"
      ? await resolvePreferredBunPath({ env: params.env, runtime: params.runtime })
      : await resolvePreferredNodePath({ env: params.env, runtime: params.runtime }));
  if (
    params.runtime === "node" &&
    !params.runtimeExplicit &&
    params.pinnedRuntimePath === undefined &&
    params.runtimePath === undefined &&
    runtimePath === undefined
  ) {
    const bunPath = await resolveRunningBunFallback({ env: params.env, nodePath: null });
    if (bunPath) {
      params.warn?.("No supported Node runtime was found; using the running Bun for the service.");
      return { devMode, runtime: "bun", runtimePath: bunPath };
    }
  }
  return { devMode, runtime: params.runtime, runtimePath };
}

export function resolveDaemonRuntimeBinDir(runtimePath?: string): string[] | undefined {
  const trimmed = runtimePath?.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  return [path.dirname(trimmed)];
}

function isOpenClawCommandBasename(basename: string, platform: NodeJS.Platform): boolean {
  if (basename === "openclaw") {
    return true;
  }
  if (platform === "win32") {
    return (
      basename === "openclaw.cmd" || basename === "openclaw.ps1" || basename === "openclaw.exe"
    );
  }
  return false;
}

function safeRealpathSync(inputPath: string): string | undefined {
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    return undefined;
  }
}

function addUniquePathDir(dirs: string[], dir: string | undefined): void {
  if (!dir || !path.isAbsolute(dir) || dirs.includes(dir)) {
    return;
  }
  dirs.push(dir);
}

/** Merge runtime and active OpenClaw binary directories for the daemon service PATH. */
export function resolveDaemonServicePathDirs(params: {
  runtimePath?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): string[] | undefined {
  const platform = params.platform ?? process.platform;
  const argv = params.argv ?? process.argv;
  const env = params.env ?? process.env;
  const argv1 = argv[1]?.trim();
  const dirs = resolveDaemonRuntimeBinDir(params.runtimePath) ?? [];

  if (
    argv1 &&
    path.isAbsolute(argv1) &&
    isOpenClawCommandBasename(path.basename(argv1), platform)
  ) {
    addUniquePathDir(dirs, path.dirname(argv1));
  }

  const argvRealpath = argv1 && path.isAbsolute(argv1) ? safeRealpathSync(argv1) : undefined;
  for (const rawSegment of (env.PATH ?? "").split(path.delimiter)) {
    const segment = rawSegment.trim();
    if (!path.isAbsolute(segment)) {
      continue;
    }
    const candidate = path.join(segment, platform === "win32" ? "openclaw.cmd" : "openclaw");
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const candidateRealpath = safeRealpathSync(candidate);
    if (argvRealpath && candidateRealpath && candidateRealpath !== argvRealpath) {
      // Update invokes dist/index.js; the same installation's shim targets openclaw.mjs.
      const activeRoot = resolveOpenClawPackageRootSync({ argv1: argvRealpath });
      if (
        !activeRoot ||
        resolveOpenClawPackageRootSync({ argv1: candidateRealpath }) !== activeRoot
      ) {
        continue;
      }
    }
    addUniquePathDir(dirs, segment);
  }

  return dirs.length > 0 ? dirs : undefined;
}
