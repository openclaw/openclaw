import { formatCliCommand } from "../../cli/command-format.js";
import { isValidProfileName } from "../../cli/profile-utils.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayPort, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { isSystemdUserServiceAvailable } from "../../daemon/systemd.js";
import type { RuntimeEnv } from "../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import { applyOnboardingLocalWorkspaceConfig } from "../onboard-config.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../onboard-helpers.js";
import {
  canEnableRescueWatchdog,
  resolveMonitoredProfileName,
  setupRescueWatchdog,
} from "../onboard-rescue.js";
import type { OnboardOptions } from "../onboard-types.js";
import { inferAuthChoiceFromFlags } from "./local/auth-choice-inference.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import { logNonInteractiveOnboardingJson } from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";
import { resolveNonInteractiveWorkspaceDir } from "./local/workspace.js";

export function resolveNonInteractiveRescueWatchdogPlan(params: {
  opts: Pick<OnboardOptions, "installDaemon" | "rescueWatchdog">;
  monitoredProfile: string;
  platform: NodeJS.Platform;
  systemdAvailable: boolean;
}) {
  const rescueRequested = params.opts.rescueWatchdog === true;
  const rescueSupported =
    rescueRequested &&
    canEnableRescueWatchdog(resolveMonitoredProfileName(params.monitoredProfile));
  const rescueAvailable =
    rescueSupported && (params.platform !== "linux" || params.systemdAvailable);
  const messages: string[] = [];

  if (rescueRequested && !rescueSupported) {
    messages.push(
      `Rescue watchdog is not supported while onboarding the "${resolveMonitoredProfileName(params.monitoredProfile)}" profile; skipping rescue watchdog setup.`,
    );
  } else if (rescueRequested && !rescueAvailable) {
    messages.push(
      "Rescue watchdog requires systemd user services on Linux, but they are unavailable here; skipping rescue watchdog setup.",
    );
  } else if (rescueAvailable && params.opts.installDaemon !== true) {
    messages.push("Rescue watchdog requested; enabling managed Gateway service install.");
  }

  return {
    installDaemon: Boolean(params.opts.installDaemon || rescueAvailable),
    rescueWatchdogEnabled: rescueAvailable,
    messages,
  };
}

export async function runNonInteractiveOnboardingLocal(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}) {
  const { opts, runtime, baseConfig } = params;
  const mode = "local" as const;

  const workspaceDir = resolveNonInteractiveWorkspaceDir({
    opts,
    baseConfig,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  let nextConfig: OpenClawConfig = applyOnboardingLocalWorkspaceConfig(baseConfig, workspaceDir);

  const inferredAuthChoice = inferAuthChoiceFromFlags(opts);
  if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive onboarding.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
  if (authChoice !== "skip") {
    const { applyNonInteractiveAuthChoice } = await import("./local/auth-choice.js");
    const nextConfigAfterAuth = await applyNonInteractiveAuthChoice({
      nextConfig,
      authChoice,
      opts,
      runtime,
      baseConfig,
    });
    if (!nextConfigAfterAuth) {
      return;
    }
    nextConfig = nextConfigAfterAuth;
  }

  const gatewayBasePort = resolveGatewayPort(baseConfig);
  const gatewayResult = applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime,
    defaultPort: gatewayBasePort,
  });
  if (!gatewayResult) {
    return;
  }
  nextConfig = gatewayResult.nextConfig;

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  const monitoredProfile = resolveMonitoredProfileName(process.env.OPENCLAW_PROFILE ?? "default");
  if (monitoredProfile !== "default" && !isValidProfileName(monitoredProfile)) {
    runtime.error(`Invalid OPENCLAW_PROFILE: ${JSON.stringify(monitoredProfile)}`);
    runtime.exit(2);
    return;
  }
  const rescuePlan = resolveNonInteractiveRescueWatchdogPlan({
    opts,
    monitoredProfile,
    platform: process.platform,
    systemdAvailable,
  });
  for (const message of rescuePlan.messages) {
    runtime.log(message);
  }
  const installDaemon = rescuePlan.installDaemon;

  nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  let primaryManagedServiceReady = !installDaemon;
  if (installDaemon) {
    const { installGatewayDaemonNonInteractive } = await import("./local/daemon-install.js");
    primaryManagedServiceReady = await installGatewayDaemonNonInteractive({
      nextConfig,
      opts: { ...opts, installDaemon },
      runtime,
      port: gatewayResult.port,
    });
    if (rescuePlan.rescueWatchdogEnabled && !primaryManagedServiceReady) {
      runtime.error(
        "Rescue watchdog requires a healthy primary managed service. Gateway service install failed during onboarding, so rescue watchdog was not configured.",
      );
      runtime.exit(1);
      return;
    }
  }

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  let rescueWatchdog;
  if (rescuePlan.rescueWatchdogEnabled) {
    try {
      rescueWatchdog = await setupRescueWatchdog({
        sourceConfig: nextConfig,
        workspaceDir,
        mainPort: gatewayResult.port,
        monitoredProfile,
        runtime: daemonRuntimeRaw,
        output: {
          log: runtime.log,
        },
      });
    } catch (error) {
      runtime.error(
        error instanceof Error ? `Rescue watchdog setup failed: ${error.message}` : String(error),
      );
      runtime.exit(1);
      return;
    }
  }
  if (!opts.skipHealth) {
    const { healthCommand } = await import("../health.js");
    const links = resolveControlUiLinks({
      bind: gatewayResult.bind as "auto" | "lan" | "loopback" | "custom" | "tailnet",
      port: gatewayResult.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    await waitForGatewayReachable({
      url: links.wsUrl,
      token: gatewayResult.gatewayToken,
      deadlineMs: 15_000,
    });
    await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayResult.port,
      bind: gatewayResult.bind,
      authMode: gatewayResult.authMode,
      tailscaleMode: gatewayResult.tailscaleMode,
    },
    installDaemon: Boolean(installDaemon),
    daemonRuntime: installDaemon ? daemonRuntimeRaw : undefined,
    rescueWatchdog,
    skipSkills: Boolean(opts.skipSkills),
    skipHealth: Boolean(opts.skipHealth),
  });

  if (!opts.json) {
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}
