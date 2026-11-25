import type { OpenClawConfig } from "../config/types.openclaw.js";
import { installDurableServiceCli } from "../daemon/durable-service-entrypoint.js";
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
  // Planning validates the runtime and wrapper; the durable copy is checked and placed during install.
  const { durableCliReplacement, ...plan } = await buildGatewayInstallPlan({
    ...runtime,
    port: params.port,
    existingCommand: params.existingCommand,
    config: params.config,
    installDurableCli: true,
    warn: params.warn,
  });
  return {
    runtime: plan.runtime,
    // Keep the prepared definition and its inspected runtime pin together.
    install: () =>
      installDurableServiceCli({
        env: runtime.env,
        replacement: durableCliReplacement,
        verify: () => params.service.isLoaded({ env: process.env }),
        warn: (message) => params.warn(message, "Gateway service"),
        install: (beforeMutation, beforeRecovery) =>
          params.service.install({
            env: process.env,
            stdout: process.stdout,
            ...plan,
            runtimePinUpdate,
            beforeMutation,
            beforeRecovery,
          }),
      }),
  };
}
