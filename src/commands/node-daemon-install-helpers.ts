import { formatNodeServiceDescription } from "../daemon/constants.js";
import { resolveNodeProgramArguments } from "../daemon/program-args.js";
import { resolvePreferredNodePath } from "../daemon/runtime-paths.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import { resolveGatewayDevMode } from "./daemon-install-helpers.js";
import {
  emitNodeRuntimeWarning,
  type DaemonInstallWarnFn,
} from "./daemon-install-runtime-warning.js";
import type { NodeDaemonRuntime } from "./node-daemon-runtime.js";

export type NodeInstallPlan = {
  programArguments: string[];
  workingDirectory?: string;
  environment: Record<string, string | undefined>;
  description?: string;
};

export async function buildNodeInstallPlan(params: {
  env: Record<string, string | undefined>;
  host: string;
  port: number;
  context?: string;
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  runtime: NodeDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<NodeInstallPlan> {
  const devMode = params.devMode ?? resolveGatewayDevMode();
  const nodePath =
    params.nodePath ??
    (await resolvePreferredNodePath({
      env: params.env,
      runtime: params.runtime,
    }));
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    host: params.host,
    port: params.port,
    context: params.context,
    tls: params.tls,
    tlsFingerprint: params.tlsFingerprint,
    nodeId: params.nodeId,
    displayName: params.displayName,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
  });

  await emitNodeRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    nodeProgram: programArguments[0],
    warn: params.warn,
    title: "Node daemon runtime",
  });

  const environment = buildNodeServiceEnvironment({ env: params.env });
  const description = formatNodeServiceDescription({
    version: environment.OPENCLAW_SERVICE_VERSION,
  });

  return { programArguments, workingDirectory, environment, description };
}
