/** Managed node-host install plan builder. */
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { resolveDurableNodeEntrypoint } from "../daemon/npx-service-install.js";
import { OPENCLAW_WRAPPER_ENV_KEY, resolveNodeProgramArguments } from "../daemon/program-args.js";
import { buildNodeServiceEnvironment } from "../daemon/service-env.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { loadNodeHostConfig } from "../node-host/config.js";
import { canReuseNodeHostDeviceToken } from "../node-host/gateway-auth.js";
import { VERSION } from "../version.js";
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
  gatewayAuthFromEnv?: boolean;
  runtime: GatewayDaemonRuntime;
  runtimeExplicit?: boolean;
  devMode?: boolean;
  runtimePath?: string;
  pinnedRuntimePath?: string;
  wrapperPath?: string;
  warn?: DaemonInstallWarnFn;
}): Promise<
  Omit<GatewayInstallPlan, "runtime"> & { description?: string; installationMessage?: string }
> {
  const wrapperPath = params.wrapperPath ?? params.env[OPENCLAW_WRAPPER_ENV_KEY];
  const { devMode, runtime, runtimePath } = await resolveDaemonInstallRuntimeInputs({
    ...params,
    wrapperPath,
  });
  const cliEntrypoint =
    !devMode && !wrapperPath ? await resolveDurableNodeEntrypoint(params.env) : undefined;
  const { programArguments, workingDirectory } = await resolveNodeProgramArguments({
    cliEntrypoint,
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
  if (params.gatewayAuthFromEnv) {
    programArguments.push("--auth-from-env");
  }

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
  if (!params.gatewayAuthFromEnv) {
    const savedGateway = (await loadNodeHostConfig(params.env))?.gateway;
    const identity = savedGateway ? loadDeviceIdentityIfPresent({ env: params.env }) : null;
    if (
      identity &&
      (await canReuseNodeHostDeviceToken({
        savedGateway,
        gatewayCandidates: [
          {
            host: params.host,
            port: params.port,
            contextPath: params.contextPath,
            tls: params.tls,
          },
        ],
        deviceId: identity.deviceId,
        env: params.env,
      }))
    ) {
      delete environment.OPENCLAW_GATEWAY_TOKEN;
      delete environment.OPENCLAW_GATEWAY_PASSWORD;
    }
  }
  return {
    programArguments,
    installationMessage: [
      `OpenClaw ${VERSION}`,
      `Runtime: ${runtime} (${programArguments[0]})`,
      `Service command: ${programArguments.map(quoteCliArg).join(" ")}`,
      `Update this node: ${formatCliCommand("openclaw node install --force", params.env).replace("openclaw", "npx -y openclaw@latest")}`,
    ].join("\n"),
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
