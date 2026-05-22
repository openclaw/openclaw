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
  runtimePath?: string;
}): Promise<{ devMode: boolean; runtimePath?: string }> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  const runtimePath =
    params.runtimePath ??
    params.nodePath ??
    (await resolvePreferredNodePath({
      env: params.env,
      runtime: params.runtime,
    }));
  return { devMode, runtimePath };
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

export function resolveDaemonRuntimeBinDir(runtimePath?: string): string[] | undefined {
  const trimmed = runtimePath?.trim();
  if (!trimmed || !isAbsoluteDaemonRuntimePath(trimmed)) {
    return undefined;
  }
  const pathModule = path.win32.isAbsolute(trimmed) ? path.win32 : path.posix;
  return [pathModule.dirname(trimmed)];
}

export const resolveDaemonNodeBinDir = resolveDaemonRuntimeBinDir;

export function isAbsoluteDaemonRuntimePath(runtimePath: string | undefined): boolean {
  const trimmed = runtimePath?.trim();
  return Boolean(trimmed && (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)));
}
