import type { OpenClawConfig } from "../../../config/config.js";
import type { GatewayServiceEnv } from "../../../daemon/service-types.js";
import { resolveGatewayService } from "../../../daemon/service.js";
import { withSystemdSystemScopeEnv } from "../../../daemon/systemd-scope.js";
import { isSystemdUserServiceAvailable } from "../../../daemon/systemd.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "../../daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, isGatewayDaemonRuntime } from "../../daemon-runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { ensureSystemdUserLingerNonInteractive } from "../../systemd-linger.js";

export async function installGatewayDaemonNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  port: number;
  gatewayToken?: string;
}) {
  const { opts, runtime, port, gatewayToken } = params;
  if (!opts.installDaemon) {
    return;
  }
  const useSystemScope = process.platform === "linux" && Boolean(opts.daemonSystem);
  const serviceEnv = withSystemdSystemScopeEnv(process.env as GatewayServiceEnv, {
    system: useSystemScope,
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  const systemdAvailable =
    process.platform === "linux"
      ? useSystemScope
        ? true
        : await isSystemdUserServiceAvailable(serviceEnv)
      : true;
  if (process.platform === "linux" && !systemdAvailable) {
    runtime.log("Systemd user services are unavailable; skipping service install.");
    return;
  }

  if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
    runtime.error("Invalid --daemon-runtime (use node or bun)");
    runtime.exit(1);
    return;
  }

  const service = resolveGatewayService();
  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: serviceEnv,
    port,
    token: gatewayToken,
    runtime: daemonRuntimeRaw,
    warn: (message) => runtime.log(message),
    config: params.nextConfig,
  });
  try {
    await service.install({
      env: serviceEnv,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
    });
  } catch (err) {
    runtime.error(`Gateway service install failed: ${String(err)}`);
    runtime.log(gatewayInstallErrorHint());
    return;
  }
  if (!useSystemScope) {
    await ensureSystemdUserLingerNonInteractive({ runtime });
  }
}
