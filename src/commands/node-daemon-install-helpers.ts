import { formatNodeServiceDescription } from "../daemon/constants.js";
import { resolveNodeProgramArguments } from "../daemon/program-args.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import {
  emitDaemonInstallRuntimeWarning,
  resolveDaemonInstallRuntimeInputs,
} from "./daemon-install-plan.shared.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
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
  tls?: boolean;
  tlsFingerprint?: string;
  nodeId?: string;
  displayName?: string;
  headers?: Record<string, string>;
  runtime: NodeDaemonRuntime;
  devMode?: boolean;
  nodePath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<NodeInstallPlan> {
  const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
    env: params.env,
    runtime: params.runtime,
    devMode: params.devMode,
    nodePath: params.nodePath,
  });
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    host: params.host,
    port: params.port,
    tls: params.tls,
    tlsFingerprint: params.tlsFingerprint,
    nodeId: params.nodeId,
    displayName: params.displayName,
    dev: devMode,
    runtime: params.runtime,
    nodePath,
  });

  await emitDaemonInstallRuntimeWarning({
    env: params.env,
    runtime: params.runtime,
    programArguments,
    warn: params.warn,
    title: "Node daemon runtime",
  });

  const environment = buildNodeServiceEnvironment({ env: params.env });
  if (params.headers && Object.keys(params.headers).length > 0) {
    environment.OPENCLAW_NODE_HEADERS = JSON.stringify(params.headers);
  } else {
    const envHeaders = params.env.OPENCLAW_NODE_HEADERS?.trim();
    if (envHeaders) {
      environment.OPENCLAW_NODE_HEADERS = envHeaders;
    }
  }
  const cfId = params.env.CF_ACCESS_CLIENT_ID?.trim();
  const cfSecret = params.env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (cfId) {
    environment.CF_ACCESS_CLIENT_ID = cfId;
  }
  if (cfSecret) {
    environment.CF_ACCESS_CLIENT_SECRET = cfSecret;
  }
  const description = formatNodeServiceDescription({
    version: environment.OPENCLAW_SERVICE_VERSION,
  });

  return { programArguments, workingDirectory, environment, description };
}
