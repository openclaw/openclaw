/** Builds Doctor service plans while preserving installed runtime and environment intent. */
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/config.js";
import { DurableServiceCliError } from "../daemon/durable-service-entrypoint.js";
import { OPENCLAW_WRAPPER_ENV_KEY } from "../daemon/program-args.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { resolveServiceEntrypoint } from "../daemon/service-layout.js";
import {
  resolveManagedGatewayServiceCommand,
  type GatewayServiceCommandConfig,
} from "../daemon/service-types.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import type { GatewayDaemonRuntime } from "./daemon-runtime.js";

export async function buildExpectedGatewayServicePlan(params: {
  cfg: OpenClawConfig;
  command: GatewayServiceCommandConfig;
  serviceInstallEnv: NodeJS.ProcessEnv;
  port: number;
  runtime: GatewayDaemonRuntime;
  runtimePath?: string;
  pinnedRuntimePath?: string;
}) {
  const managed = resolveManagedGatewayServiceCommand(params.command);
  const recordedNode = managed?.programArguments[0];
  let runtimePath = params.runtimePath;
  if (
    runtimePath === undefined &&
    !params.pinnedRuntimePath &&
    params.runtime === "node" &&
    !params.serviceInstallEnv[OPENCLAW_WRAPPER_ENV_KEY]?.trim() &&
    recordedNode &&
    isNodeRuntime(recordedNode) &&
    (await resolveNodeRuntimeInfo(recordedNode, params.serviceInstallEnv)).status === "supported"
  ) {
    runtimePath = recordedNode;
  }
  const plan = (serviceCli?: { executable: string; entrypoint: string }) =>
    buildGatewayInstallPlan({
      ...(serviceCli ? { serviceCli } : {}),
      env: params.serviceInstallEnv,
      port: params.port,
      runtime: params.runtime,
      runtimePath,
      pinnedRuntimePath: params.pinnedRuntimePath,
      existingCommand: params.command,
      existingEnvironment: managed?.environment,
      existingEnvironmentValueSources: managed?.environmentValueSources,
      warn: (message, title) => note(message, title),
      config: params.cfg,
    });
  const retained = managed && resolveServiceEntrypoint(managed);
  try {
    return await plan();
  } catch (error) {
    // Doctor never installs: report the explicit reinstall and keep the service's CLI.
    if (!(error instanceof DurableServiceCliError) || !retained) {
      throw error;
    }
    note(error.message, "Gateway service");
    return await plan({ executable: process.execPath, entrypoint: retained });
  }
}
