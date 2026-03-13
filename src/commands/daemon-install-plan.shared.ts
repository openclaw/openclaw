import type { GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";

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
