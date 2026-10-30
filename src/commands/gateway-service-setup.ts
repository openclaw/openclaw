import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayService, GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import type { DaemonInstallWarnFn } from "./daemon-install-runtime-warning.js";
import type { resolveGatewaySetupRuntime } from "./gateway-setup-runtime.js";

export async function prepareGatewayServiceInstall(params: {
  service: GatewayService;
  selection: Awaited<ReturnType<typeof resolveGatewaySetupRuntime>>;
  existingCommand: GatewayServiceCommandConfig | null;
  config: OpenClawConfig;
  port: number;
  warn: DaemonInstallWarnFn;
}) {
  const { runtimePinUpdate, ...runtime } = params.selection;
  const plan = await buildGatewayInstallPlan({
    ...runtime,
    port: params.port,
    existingCommand: params.existingCommand,
    config: params.config,
    warn: params.warn,
  });
  return {
    runtime: plan.runtime,
    // Keep the prepared definition and its inspected runtime pin together.
    install: () =>
      params.service.install({
        env: process.env,
        stdout: process.stdout,
        ...plan,
        runtimePinUpdate,
      }),
  };
}
