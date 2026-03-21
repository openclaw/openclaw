import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayPort, writeConfigFile } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME } from "../daemon-runtime.js";
import {
  applyLocalSetupWorkspaceConfig,
  resolveOnboardingWorkspaceDir,
} from "../onboard-config.js";
import { runGatewayReachabilityHealthWorkflow } from "../onboard-gateway-health.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
} from "../onboard-helpers.js";
import { resolveLocalGatewayReachabilityPlan } from "../onboard-local-gateway.js";
import { createLocalSetupIntent, resolveLocalSetupExecutionPlan } from "../onboard-local-plan.js";
import { createLocalOnboardingPlan } from "../onboard-plan.js";
import type { OnboardOptions } from "../onboard-types.js";
import { inferAuthChoiceFromFlags } from "./local/auth-choice-inference.js";
import { applyNonInteractiveGatewayConfig } from "./local/gateway-config.js";
import {
  type GatewayHealthFailureDiagnostics,
  logNonInteractiveOnboardingFailure,
  logNonInteractiveOnboardingJson,
} from "./local/output.js";
import { applyNonInteractiveSkillsConfig } from "./local/skills-config.js";

async function collectGatewayHealthFailureDiagnostics(): Promise<
  GatewayHealthFailureDiagnostics | undefined
> {
  const diagnostics: GatewayHealthFailureDiagnostics = {};

  try {
    const { resolveGatewayService } = await import("../../daemon/service.js");
    const service = resolveGatewayService();
    const env = process.env as Record<string, string | undefined>;
    const [loaded, runtime] = await Promise.all([
      service.isLoaded({ env }).catch(() => false),
      service.readRuntime(env).catch(() => undefined),
    ]);
    diagnostics.service = {
      label: service.label,
      loaded,
      loadedText: service.loadedText,
      runtimeStatus: runtime?.status,
      state: runtime?.state,
      pid: runtime?.pid,
      lastExitStatus: runtime?.lastExitStatus,
      lastExitReason: runtime?.lastExitReason,
    };
  } catch (err) {
    diagnostics.inspectError = `service diagnostics failed: ${String(err)}`;
  }

  try {
    const { readLastGatewayErrorLine } = await import("../../daemon/diagnostics.js");
    diagnostics.lastGatewayError = (await readLastGatewayErrorLine(process.env)) ?? undefined;
  } catch (err) {
    diagnostics.inspectError = diagnostics.inspectError
      ? `${diagnostics.inspectError}; log diagnostics failed: ${String(err)}`
      : `log diagnostics failed: ${String(err)}`;
  }

  return diagnostics.service || diagnostics.lastGatewayError || diagnostics.inspectError
    ? diagnostics
    : undefined;
}

export async function runNonInteractiveLocalSetup(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}) {
  const { opts, runtime, baseConfig } = params;
  const mode = "local" as const;

  const workspaceDir = resolveOnboardingWorkspaceDir({
    requestedWorkspace: opts.workspace,
    configuredWorkspace: baseConfig.agents?.defaults?.workspace,
    defaultWorkspaceDir: DEFAULT_WORKSPACE,
  });

  let nextConfig: OpenClawConfig = applyLocalSetupWorkspaceConfig(baseConfig, workspaceDir);

  const inferredAuthChoice = inferAuthChoiceFromFlags(opts);
  if (!opts.authChoice && inferredAuthChoice.matches.length > 1) {
    runtime.error(
      [
        "Multiple API key flags were provided for non-interactive setup.",
        "Use a single provider flag or pass --auth-choice explicitly.",
        `Flags: ${inferredAuthChoice.matches.map((match) => match.label).join(", ")}`,
      ].join("\n"),
    );
    runtime.exit(1);
    return;
  }
  const authChoice = opts.authChoice ?? inferredAuthChoice.choice ?? "skip";
  // Resolve the shared local setup intent once so auth/workspace/daemon/health
  // expectations stop being reconstructed in later branches and log paths.
  const setupIntent = createLocalSetupIntent({
    workspaceDir,
    authChoice,
    installDaemon: opts.installDaemon,
    skipHealth: opts.skipHealth,
  });
  const executionPlan = resolveLocalSetupExecutionPlan({
    intent: setupIntent,
    executionMode: "non-interactive",
    platform: process.platform,
  });

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
  const gatewayState = gatewayResult.state;
  const onboardingPlan = createLocalOnboardingPlan({
    executionMode: "non-interactive",
    intent: setupIntent,
    gatewayState,
    executionPlan,
    opts,
  });
  const localExecutionPlan = onboardingPlan.executionPlan;

  if (onboardingPlan.steps.skills.decision === "run") {
    nextConfig = applyNonInteractiveSkillsConfig({ nextConfig, opts, runtime });
  }

  nextConfig = applyWizardMetadata(nextConfig, { command: "onboard", mode });
  await writeConfigFile(nextConfig);
  logConfigUpdated(runtime);

  await ensureWorkspaceAndSessions(workspaceDir, runtime, {
    skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
  });

  const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
  let daemonInstallStatus:
    | {
        requested: boolean;
        installed: boolean;
        skippedReason?: "systemd-user-unavailable";
      }
    | undefined;
  if (onboardingPlan.steps.daemon.decision === "install") {
    const { installGatewayDaemonNonInteractive } = await import("./local/daemon-install.js");
    const daemonInstall = await installGatewayDaemonNonInteractive({
      nextConfig,
      opts,
      runtime,
      port: gatewayState.port,
    });
    daemonInstallStatus = daemonInstall.installed
      ? {
          requested: true,
          installed: true,
        }
      : {
          requested: true,
          installed: false,
          skippedReason: daemonInstall.skippedReason,
        };
    if (!daemonInstall.installed && !opts.skipHealth) {
      logNonInteractiveOnboardingFailure({
        opts,
        runtime,
        mode,
        phase: "daemon-install",
        message:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? "Gateway service install is unavailable because systemd user services are not reachable in this Linux session."
            : "Gateway service install did not complete successfully.",
        installDaemon: true,
        daemonInstall: {
          requested: true,
          installed: false,
          skippedReason: daemonInstall.skippedReason,
        },
        daemonRuntime: daemonRuntimeRaw,
        hints:
          daemonInstall.skippedReason === "systemd-user-unavailable"
            ? [
                "Fix: rerun without `--install-daemon` for one-shot setup, or enable a working user-systemd session and retry.",
                "If your auth profile uses env-backed refs, keep those env vars set in the shell that runs `openclaw gateway run` or `openclaw agent --local`.",
              ]
            : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
      });
      runtime.exit(1);
      return;
    }
  }

  if (onboardingPlan.steps.health.decision === "run") {
    const reachabilityPlan = await resolveLocalGatewayReachabilityPlan({
      state: gatewayState,
      config: nextConfig,
      env: process.env,
      executionPlan: localExecutionPlan,
    });
    const probe = await runGatewayReachabilityHealthWorkflow({
      runtime,
      wsUrl: reachabilityPlan.wsUrl,
      token: reachabilityPlan.token,
      password: reachabilityPlan.password,
      deadlineMs: reachabilityPlan.deadlineMs,
    });
    if (!probe.ok) {
      const diagnostics =
        executionPlan.healthExpectation === "managed-gateway"
          ? await collectGatewayHealthFailureDiagnostics()
          : undefined;
      logNonInteractiveOnboardingFailure({
        opts,
        runtime,
        mode,
        phase: "gateway-health",
        message: `Gateway did not become reachable at ${reachabilityPlan.wsUrl}.`,
        detail: probe.detail,
        gateway: {
          wsUrl: reachabilityPlan.wsUrl,
          httpUrl: reachabilityPlan.httpUrl,
        },
        installDaemon: localExecutionPlan.daemonDecision === "install",
        daemonInstall: daemonInstallStatus,
        daemonRuntime:
          localExecutionPlan.daemonDecision === "install" ? daemonRuntimeRaw : undefined,
        diagnostics,
        hints:
          localExecutionPlan.healthExpectation === "existing-gateway"
            ? [
                "Non-interactive local setup only waits for an already-running gateway unless you pass --install-daemon.",
                `Fix: start \`${formatCliCommand("openclaw gateway run")}\`, re-run with \`--install-daemon\`, or use \`--skip-health\`.`,
                process.platform === "win32"
                  ? "Native Windows managed gateway install tries Scheduled Tasks first and falls back to a per-user Startup-folder login item when task creation is denied."
                  : undefined,
              ].filter((value): value is string => Boolean(value))
            : [`Run \`${formatCliCommand("openclaw gateway status --deep")}\` for more detail.`],
      });
      runtime.exit(1);
      return;
    }
  }

  logNonInteractiveOnboardingJson({
    opts,
    runtime,
    mode,
    workspaceDir,
    authChoice,
    gateway: {
      port: gatewayState.port,
      bind: gatewayState.bind,
      authMode: gatewayState.authMode,
      tailscaleMode: gatewayState.tailscaleMode,
    },
    installDaemon: localExecutionPlan.daemonDecision === "install",
    daemonInstall: daemonInstallStatus,
    daemonRuntime: localExecutionPlan.daemonDecision === "install" ? daemonRuntimeRaw : undefined,
    skipSkills: onboardingPlan.steps.skills.decision === "skip",
    skipHealth: onboardingPlan.steps.health.decision === "skip",
  });

  if (!opts.json) {
    runtime.log(
      `Tip: run \`${formatCliCommand("openclaw configure --section web")}\` to store your Brave API key for web_search. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
}
