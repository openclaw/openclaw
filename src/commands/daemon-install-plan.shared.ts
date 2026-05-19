import fs from "node:fs";
import path from "node:path";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export function resolveGatewayDevMode(argv: string[] = process.argv): boolean {
  const entry = argv[1];
  const normalizedEntry = entry?.replaceAll("\\", "/");
  return normalizedEntry?.includes("/src/") && normalizedEntry.endsWith(".ts");
}

export async function resolveDaemonInstallRuntimeInputs(params: {
  env: Record<string, string | undefined>;
  runtime: GatewayDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
}): Promise<{ devMode: boolean; nodePath?: string }> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  const nodePath =
    params.nodePath ??
    (await resolvePreferredNodePath({
      env: params.env,
      runtime: params.runtime,
    }));
  return { devMode, nodePath };
}

export async function emitDaemonInstallRuntimeWarning(params: {
  env: Record<string, string | undefined>;
  runtime: GatewayDaemonRuntime;
  programArguments: string[];
  warn?: DaemonInstallWarnFn;
  title: string;
}): Promise<void> {
  await emitNodeRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    nodeProgram: params.programArguments[0],
    warn: params.warn,
    title: params.title,
  });
}

export function resolveDaemonNodeBinDir(nodePath?: string): string[] | undefined {
  const trimmed = nodePath?.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  return [path.dirname(trimmed)];
}

// Service PATH on macOS is intentionally narrow (system + homebrew only) — see
// resolveSystemPathDirs / getMinimalServicePathParts in src/daemon/service-env.ts.
// That excludes prefix-based installs like ~/.npm-global/bin, which silently breaks
// child processes (agent shells, hooks) that try to invoke `openclaw` from PATH.
// Detecting the install-time openclaw bin dir keeps the minimal-PATH security posture
// while ensuring the gateway's own CLI is always reachable from its supervised env.
export function resolveOpenclawBinDir(options?: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  existsSync?: (candidate: string) => boolean;
}): string[] | undefined {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const existsSync = options?.existsSync ?? fs.existsSync;
  const rawPath = env.PATH ?? env.Path ?? env.path;
  if (!rawPath) {
    return undefined;
  }
  const basenames =
    platform === "win32"
      ? ["openclaw.cmd", "openclaw.exe", "openclaw.bat", "openclaw"]
      : ["openclaw"];
  const pathPlatform = platform === "win32" ? path.win32 : path.posix;
  for (const rawSegment of rawPath.split(pathPlatform.delimiter)) {
    const segment = rawSegment.trim();
    if (!segment || !pathPlatform.isAbsolute(segment)) {
      continue;
    }
    for (const basename of basenames) {
      if (existsSync(pathPlatform.join(segment, basename))) {
        return [segment];
      }
    }
  }
  return undefined;
}

export function resolveDaemonExtraPathDirs(params: {
  nodePath?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  existsSync?: (candidate: string) => boolean;
}): string[] | undefined {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const append = (entries: string[] | undefined) => {
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      if (seen.has(entry)) {
        continue;
      }
      seen.add(entry);
      dirs.push(entry);
    }
  };
  append(
    resolveOpenclawBinDir({
      env: params.env,
      platform: params.platform,
      existsSync: params.existsSync,
    }),
  );
  append(resolveDaemonNodeBinDir(params.nodePath));
  return dirs.length > 0 ? dirs : undefined;
}
