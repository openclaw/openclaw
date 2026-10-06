/** Managed node-host install plan builder. */
import { OPENCLAW_WRAPPER_ENV_KEY, resolveNodeProgramArguments } from "../daemon/program-args.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import {
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonRuntimeBinDir,
  type GatewayInstallPlan,
} from "./daemon-install-plan.shared.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

/** Builds launch arguments, environment, and metadata for a managed node-host service install. */
export async function buildNodeInstallPlan(params: {
  env: Record<string, string | undefined>;
  host: string;
  port: number;
  contextPath?: string;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  installedAppsSharing?: boolean;
  commands?: string[];
  allCommands?: boolean;
  runtime: GatewayDaemonRuntime;
  runtimeExplicit?: boolean;
  devMode?: boolean;
  runtimePath?: string;
  pinnedRuntimePath?: string;
  wrapperPath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<Omit<GatewayInstallPlan, "runtime"> & { description?: string }> {
  const wrapperPath = params.wrapperPath ?? params.env[OPENCLAW_WRAPPER_ENV_KEY];
  const { devMode, runtime, runtimePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    runtimeExplicit: params.runtimeExplicit,
    devMode: params.devMode,
    runtimePath: params.runtimePath,
    pinnedRuntimePath: params.pinnedRuntimePath,
    wrapperPath,
    warn: params.warn,
  });
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    host: params.host,
    port: params.port,
    contextPath: params.contextPath,
    tls: params.tls,
    tlsFingerprint: params.tlsFingerprint,
    nodeId: params.nodeId,
    displayName: params.displayName,
    installedAppsSharing: params.installedAppsSharing,
    commands: params.commands,
    allCommands: params.allCommands,
    dev: devMode,
    runtime,
    runtimePath,
    wrapperPath,
  });

  await emitNodeRuntimeWarning({
    env: params.env,
    runtime,
    nodeProgram: programArguments[0],
    warn: params.warn,
    title: "Node daemon runtime",
  });

  const environment = buildNodeServiceEnvironment({
    env: params.env,
    runtime,
    // Match the Gateway install path so supervised services keep the chosen
    // runtime toolchain on PATH for sibling binaries when needed.
    extraPathDirs: resolveDaemonRuntimeBinDir(runtimePath),
  });
  return {
    programArguments,
    workingDirectory,
    environment,
    environmentValueSources: {
      OPENCLAW_GATEWAY_TOKEN: "file",
      OPENCLAW_GATEWAY_PASSWORD: "file", // pragma: allowlist secret
      CF_ACCESS_CLIENT_ID: "file",
      CF_ACCESS_CLIENT_SECRET: "file", // pragma: allowlist secret
    },
    description: "OpenClaw Node Host",
  };
}
