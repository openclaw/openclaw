/** Builds Doctor service plans while preserving installed runtime and environment intent. */
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/config.js";
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
  return buildGatewayInstallPlan({
    env: params.serviceInstallEnv,
    port: params.port,
    runtime: params.runtime,
    runtimePath: params.runtimePath,
    pinnedRuntimePath: params.pinnedRuntimePath,
    existingCommand: params.command,
    existingEnvironment: managed?.environment,
    existingEnvironmentValueSources: managed?.environmentValueSources,
    warn: (message, title) => note(message, title),
    config: params.cfg,
  });
}
