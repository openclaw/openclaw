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
  return Boolean(normalizedEntry?.includes("/src/") && normalizedEntry.endsWith(".ts"));
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

function resolveVitePlusCompanionBinDir(nodePath: string): string | undefined {
  const normalized = nodePath.replaceAll("\\", "/");
  const marker = "/.vite-plus/js_runtime/node/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const vitePlusRoot = `${normalized.slice(0, markerIndex)}/.vite-plus`;
  return path.normalize(path.join(vitePlusRoot, "bin"));
}

export function resolveDaemonNodeBinDir(nodePath?: string): string[] | undefined {
  const trimmed = nodePath?.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return undefined;
  }
  const dirs = [path.dirname(trimmed)];
  const vitePlusBinDir = resolveVitePlusCompanionBinDir(trimmed);
  if (vitePlusBinDir && !dirs.includes(vitePlusBinDir)) {
    dirs.push(vitePlusBinDir);
  }
  return dirs;
}
