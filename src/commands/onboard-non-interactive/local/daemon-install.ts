import type { OpenClawConfig } from "../../../config/config.js";
import { resolveGatewayService } from "../../../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../../../daemon/systemd.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "../../daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, isGatewayDaemonRuntime } from "../../daemon-runtime.js";
import { resolveGatewayInstallToken } from "../../gateway-install-token.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { ensureSystemdUserLingerNonInteractive } from "../../systemd-linger.js";

export async function installGatewayDaemonNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  port: number;
}) {
  const { opts, runtime, port } = params;
  if (!opts.installDaemon) {
    return;
  }

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
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
  const tokenResolution = await resolveGatewayInstallToken({
    config: params.nextConfig,
    env: process.env,
  });
  for (const warning of tokenResolution.warnings) {
    runtime.log(warning);
  }
  if (tokenResolution.unavailableReason) {
    runtime.error(
      [
        "Gateway install blocked:",
        tokenResolution.unavailableReason,
        "Fix gateway auth config/token input and rerun onboarding.",
      ].join(" "),
    );
    runtime.exit(1);
    return;
  }
  const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
    env: process.env,
    port,
    runtime: daemonRuntimeRaw,
    warn: (message) => runtime.log(message),
    config: params.nextConfig,
  });
  try {
    await service.install({
      env: process.env,
      stdout: process.stdout,
      programArguments,
      workingDirectory,
      environment,
      watchdog: true,
    });
  } catch (err) {
    runtime.error(`Gateway service install failed: ${String(err)}`);
    runtime.log(gatewayInstallErrorHint());
    return;
  }
  await ensureSystemdUserLingerNonInteractive({ runtime });
}
