import { formatNodeServiceDescription } from "../daemon/constants.js";
import {
  OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY,
  resolveNodeProgramArguments,
  resolveOpenClawRuntimePath,
} from "../daemon/program-args.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import type { GatewayServiceEnvironmentValueSource } from "../daemon/service-types.js";
import {
  emitDaemonInstallRuntimeWarning,
  isAbsoluteDaemonRuntimePath,
  resolveDaemonInstallRuntimeInputs,
  resolveDaemonRuntimeBinDir,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { NodeDaemonRuntime } from "./node-daemon-runtime.js";

type NodeInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  description?: string;
};

function buildNodeInstallEnvironmentValueSources(): Record<
  string,
  GatewayServiceEnvironmentValueSource | undefined
> {
  return {
    OPENCLAW_GATEWAY_TOKEN: "file",
  };
}

export async function buildNodeInstallPlan(params: {
  env: Record<string, string | undefined>;
  host: string;
  port: number;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  runtime: NodeDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  runtimePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<NodeInstallPlan> {
  const requestedRuntimePath =
    params.runtimePath ?? params.env[OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY];
  const explicitRuntimePath = await resolveOpenClawRuntimePath(
    requestedRuntimePath,
    params.runtime,
  );
  const { devMode, runtimePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    devMode: params.devMode,
    runtimePath: explicitRuntimePath ?? params.nodePath,
  });
  const programRuntimePath = isAbsoluteDaemonRuntimePath(runtimePath) ? runtimePath : undefined;
  const legacyNodePath = programRuntimePath ? undefined : runtimePath;
  const serviceRuntimePath =
    explicitRuntimePath && isAbsoluteDaemonRuntimePath(runtimePath) ? runtimePath : undefined;
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    host: params.host,
    port: params.port,
    tls: params.tls,
    tlsFingerprint: params.tlsFingerprint,
    nodeId: params.nodeId,
    displayName: params.displayName,
    dev: devMode,
    runtime: params.runtime,
    nodePath: legacyNodePath,
    runtimePath: programRuntimePath,
  });

  await emitDaemonInstallRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "Node daemon runtime",
  });

  const environment = buildNodeServiceEnvironment({
    env: {
      ...params.env,
      ...(serviceRuntimePath ? { [OPENCLAW_DAEMON_RUNTIME_PATH_ENV_KEY]: serviceRuntimePath } : {}),
    },
    // Match the gateway install path so supervised node services keep the chosen
    // runtime toolchain on PATH for sibling binaries like npm/pnpm when needed.
    extraPathDirs: resolveDaemonRuntimeBinDir(runtimePath),
  });
  const description = formatNodeServiceDescription({
    version: environment.OPENCLAW_SERVICE_VERSION,
  });

  return {
    programArguments,
    workingDirectory,
    environment,
    environmentValueSources: buildNodeInstallEnvironmentValueSources(),
    description,
  };
}
