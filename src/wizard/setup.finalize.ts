import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  buildGatewayInstallPlan,
  gatewayInstallErrorHint,
} from "../commands/daemon-install-helpers.js";
import {
  DEFAULT_GATEWAY_DAEMON_RUNTIME,
  GATEWAY_DAEMON_RUNTIME_OPTIONS,
} from "../commands/daemon-runtime.js";
import { resolveGatewayInstallToken } from "../commands/gateway-install-token.js";
import { formatHealthCheckFailure } from "../commands/health-format.js";
import { healthCommand } from "../commands/health.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  probeGatewayReachable,
  waitForGatewayReachable,
} from "../commands/onboard-helpers.js";
import {
  resolveLocalGatewayLinks,
  resolveLocalGatewayReachabilityAuth,
} from "../commands/onboard-local-gateway.js";
import {
  resolveLocalSetupExecutionPlan,
  type LocalSetupIntent,
} from "../commands/onboard-local-plan.js";
import { createLocalOnboardingPlan, type OnboardingPlan } from "../commands/onboard-plan.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { runTui } from "../tui/tui.js";
import { resolveUserPath } from "../utils.js";
import type { WizardPrompter } from "./prompts.js";
import { setupWizardShellCompletion } from "./setup.completion.js";
import type { GatewayWizardSettings, WizardFlow } from "./setup.types.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  intent: LocalSetupIntent;
  onboardingPlan: OnboardingPlan;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

export async function finalizeSetupWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;

  const withWizardProgress = async <T>(
    label: string,
    options: { doneMessage?: string | (() => string | undefined) },
    work: (progress: { update: (message: string) => void }) => Promise<T>,
  ): Promise<T> => {
    const progress = prompter.progress(label);
    try {
      return await work(progress);
    } finally {
      progress.stop(
        typeof options.doneMessage === "function" ? options.doneMessage() : options.doneMessage,
      );
    }
  };

  const systemdAvailable =
    process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
  if (process.platform === "linux" && !systemdAvailable) {
    await prompter.note(
      "Systemd user services are unavailable. Skipping lingering checks and service install.",
      "Systemd",
    );
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason:
        "Linux installs use a systemd user service by default. Without lingering, systemd stops the user session on logout/idle and kills the Gateway.",
      requireConfirm: false,
    });
  }

  // Resolve the wizard's execution plan from the shared local intent instead of
  // re-deriving defaults inline, so quickstart/advanced behavior stays inspectable.
  let setupPlan = resolveLocalSetupExecutionPlan({
    intent: options.intent,
    executionMode: "interactive",
    flow,
    platform: process.platform,
    systemdAvailable,
  });
  let onboardingPlan = options.onboardingPlan;
  // Linux systemd availability is only known here, so finalize recomputes the
  // pure plan once with that fact before executing any daemon/health branches.
  onboardingPlan = createLocalOnboardingPlan({
    executionMode: "interactive",
    flow,
    intent: onboardingPlan.intent,
    gatewayState: settings,
    executionPlan: setupPlan,
    opts,
  });
  let installDaemon = onboardingPlan.steps.daemon.decision === "install";
  if (setupPlan.daemonDecision === "prompt") {
    const installConfirmed = await prompter.confirm({
      message: "Install Gateway service (recommended)",
      initialValue: true,
    });
    // Interactive finalize is the only place that is allowed to turn the
    // shared pure plan into a user decision. Once confirmed, recompute the
    // plan and keep executing from the updated intent instead of branching ad hoc.
    setupPlan = resolveLocalSetupExecutionPlan({
      intent: {
        ...options.intent,
        daemonPreference: installConfirmed ? "install" : "skip",
      },
      executionMode: "interactive",
      flow,
      platform: process.platform,
      systemdAvailable,
    });
    onboardingPlan = createLocalOnboardingPlan({
      executionMode: "interactive",
      flow,
      intent: {
        ...options.intent,
        daemonPreference: installConfirmed ? "install" : "skip",
      },
      gatewayState: settings,
      executionPlan: setupPlan,
      opts,
    });
    installDaemon = onboardingPlan.steps.daemon.decision === "install";
  }

  if (setupPlan.daemonDecisionReason === "systemd-unavailable") {
    await prompter.note(
      "Systemd user services are unavailable; skipping service install. Use your container supervisor or `docker compose up -d`.",
      "Gateway service",
    );
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? DEFAULT_GATEWAY_DAEMON_RUNTIME
        : await prompter.select({
            message: "Gateway service runtime",
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          });
    if (flow === "quickstart") {
      await prompter.note(
        "QuickStart uses Node for the Gateway service (stable + supported).",
        "Gateway service runtime",
      );
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    let restartWasScheduled = false;
    if (loaded) {
      const action = await prompter.select({
        message: "Gateway service already installed",
        options: [
          { value: "restart", label: "Restart" },
          { value: "reinstall", label: "Reinstall" },
          { value: "skip", label: "Skip" },
        ],
      });
      if (action === "restart") {
        let restartDoneMessage = "Gateway service restarted.";
        await withWizardProgress(
          "Gateway service",
          { doneMessage: () => restartDoneMessage },
          async (progress) => {
            progress.update("Restarting Gateway service…");
            const restartResult = await service.restart({
              env: process.env,
              stdout: process.stdout,
            });
            const restartStatus = describeGatewayServiceRestart("Gateway", restartResult);
            restartDoneMessage = restartStatus.progressMessage;
            restartWasScheduled = restartStatus.scheduled;
          },
        );
      } else if (action === "reinstall") {
        await withWizardProgress(
          "Gateway service",
          { doneMessage: "Gateway service uninstalled." },
          async (progress) => {
            progress.update("Uninstalling Gateway service…");
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (
      !loaded ||
      (!restartWasScheduled && loaded && !(await service.isLoaded({ env: process.env })))
    ) {
      const progress = prompter.progress("Gateway service");
      let installError: string | null = null;
      try {
        progress.update("Preparing Gateway service…");
        const tokenResolution = await resolveGatewayInstallToken({
          config: nextConfig,
          env: process.env,
        });
        for (const warning of tokenResolution.warnings) {
          await prompter.note(warning, "Gateway service");
        }
        if (tokenResolution.unavailableReason) {
          installError = [
            "Gateway install blocked:",
            tokenResolution.unavailableReason,
            "Fix gateway auth config/token input and rerun setup.",
          ].join(" ");
        } else {
          const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan(
            {
              env: process.env,
              port: settings.port,
              runtime: daemonRuntime,
              warn: (message, title) => prompter.note(message, title),
              config: nextConfig,
            },
          );

          progress.update("Installing Gateway service…");
          await service.install({
            env: process.env,
            stdout: process.stdout,
            programArguments,
            workingDirectory,
            environment,
          });
        }
      } catch (err) {
        installError = err instanceof Error ? err.message : String(err);
      } finally {
        progress.stop(
          installError ? "Gateway service install failed." : "Gateway service installed.",
        );
      }
      if (installError) {
        await prompter.note(`Gateway service install failed: ${installError}`, "Gateway");
        await prompter.note(gatewayInstallErrorHint(), "Gateway");
      }
    }
  }

  if (onboardingPlan.steps.health.decision === "run") {
    const probeLinks = resolveLocalGatewayLinks({
      state: settings,
    });
    const probeAuth = await resolveLocalGatewayReachabilityAuth({
      state: settings,
      config: nextConfig,
      env: process.env,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: probeAuth.token,
      password: probeAuth.password,
      deadlineMs: 15_000,
    });
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(
        [
          "Docs:",
          "https://docs.openclaw.ai/gateway/health",
          "https://docs.openclaw.ai/gateway/troubleshooting",
        ].join("\n"),
        "Health check help",
      );
    }
  }

  const controlUiEnabled =
    nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
  if (onboardingPlan.steps.ui.decision !== "skip" && controlUiEnabled) {
    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }
  }

  await prompter.note(
    [
      "Add nodes for extra features:",
      "- macOS app (system + notifications)",
      "- iOS app (camera/canvas)",
      "- Android app (camera/canvas)",
    ].join("\n"),
    "Optional apps",
  );

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveLocalGatewayLinks({
    state: settings,
    basePath: controlUiBasePath,
  });
  const authedUrl =
    settings.authMode === "token" && settings.gatewayToken
      ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}`
      : links.httpUrl;
  let gatewayAuth = { token: settings.gatewayToken, password: "" };
  try {
    const resolvedAuth = await resolveLocalGatewayReachabilityAuth({
      state: settings,
      config: nextConfig,
      env: process.env,
    });
    gatewayAuth = {
      token: resolvedAuth.token,
      password: resolvedAuth.password ?? "",
    };
  } catch (error) {
    await prompter.note(
      [
        "Could not resolve gateway.auth.password SecretRef for setup auth.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
      "Gateway auth",
    );
  }

  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: gatewayAuth.token,
    password: gatewayAuth.password,
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? "Gateway: reachable"
    : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
  const bootstrapPath = path.join(
    resolveUserPath(options.workspaceDir),
    DEFAULT_BOOTSTRAP_FILENAME,
  );
  const hasBootstrap = await fs
    .access(bootstrapPath)
    .then(() => true)
    .catch(() => false);

  await prompter.note(
    [
      `Web UI: ${links.httpUrl}`,
      settings.authMode === "token" && settings.gatewayToken
        ? `Web UI (with token): ${authedUrl}`
        : undefined,
      `Gateway WS: ${links.wsUrl}`,
      gatewayStatusLine,
      "Docs: https://docs.openclaw.ai/web/control-ui",
    ]
      .filter(Boolean)
      .join("\n"),
    "Control UI",
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;
  let launchedTui = false;

  if (onboardingPlan.steps.ui.decision !== "skip" && gatewayProbe.ok) {
    if (hasBootstrap) {
      await prompter.note(
        [
          "This is the defining action that makes your agent you.",
          "Please take your time.",
          "The more you tell it, the better the experience will be.",
          'We will send: "Wake up, my friend!"',
        ].join("\n"),
        "Start TUI (best option!)",
      );
    }

    await prompter.note(
      [
        "Gateway token: shared auth for the Gateway + Control UI.",
        "Stored in: ~/.openclaw/openclaw.json (gateway.auth.token) or OPENCLAW_GATEWAY_TOKEN.",
        `View token: ${formatCliCommand("openclaw config get gateway.auth.token")}`,
        `Generate token: ${formatCliCommand("openclaw doctor --generate-gateway-token")}`,
        "Web UI keeps dashboard URL tokens in memory for the current tab and strips them from the URL after load.",
        `Open the dashboard anytime: ${formatCliCommand("openclaw dashboard --no-open")}`,
        "If prompted: paste the token into Control UI settings (or use the tokenized dashboard URL).",
      ].join("\n"),
      "Token",
    );

    hatchChoice = await prompter.select({
      message: "How do you want to hatch your bot?",
      options: [
        { value: "tui", label: "Hatch in TUI (recommended)" },
        { value: "web", label: "Open the Web UI" },
        { value: "later", label: "Do this later" },
      ],
      initialValue: "tui",
    });

    if (hatchChoice === "tui") {
      restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: true });
      await runTui({
        url: links.wsUrl,
        token: gatewayAuth.token,
        password: gatewayAuth.password,
        // Safety: setup TUI should not auto-deliver to lastProvider/lastTo.
        deliver: false,
        message: hasBootstrap ? "Wake up, my friend!" : undefined,
      });
      launchedTui = true;
    } else if (hatchChoice === "web") {
      const browserSupport = await detectBrowserOpenSupport();
      if (browserSupport.ok) {
        controlUiOpened = await openUrl(authedUrl);
        if (!controlUiOpened) {
          controlUiOpenHint = formatControlUiSshHint({
            port: settings.port,
            basePath: controlUiBasePath,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
          });
        }
      } else {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        });
      }
      await prompter.note(
        [
          `Dashboard link (with token): ${authedUrl}`,
          controlUiOpened
            ? "Opened in your browser. Keep that tab to control OpenClaw."
            : "Copy/paste this URL in a browser on this machine to control OpenClaw.",
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        "Dashboard ready",
      );
    } else {
      await prompter.note(
        `When you're ready: ${formatCliCommand("openclaw dashboard --no-open")}`,
        "Later",
      );
    }
  } else if (onboardingPlan.steps.ui.decision === "skip") {
    await prompter.note("Skipping Control UI/TUI prompts.", "Control UI");
  }

  await prompter.note(
    [
      "Back up your agent workspace.",
      "Docs: https://docs.openclaw.ai/concepts/agent-workspace",
    ].join("\n"),
    "Workspace backup",
  );

  await prompter.note(
    "Running agents on your computer is risky — harden your setup: https://docs.openclaw.ai/security",
    "Security",
  );

  await setupWizardShellCompletion({ flow, prompter });

  const shouldOpenControlUi =
    onboardingPlan.steps.ui.decision !== "skip" &&
    settings.authMode === "token" &&
    Boolean(settings.gatewayToken) &&
    hatchChoice === null;
  if (shouldOpenControlUi) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      controlUiOpened = await openUrl(authedUrl);
      if (!controlUiOpened) {
        controlUiOpenHint = formatControlUiSshHint({
          port: settings.port,
          basePath: controlUiBasePath,
          token: settings.gatewayToken,
        });
      }
    } else {
      controlUiOpenHint = formatControlUiSshHint({
        port: settings.port,
        basePath: controlUiBasePath,
        token: settings.gatewayToken,
      });
    }

    await prompter.note(
      [
        `Dashboard link (with token): ${authedUrl}`,
        controlUiOpened
          ? "Opened in your browser. Keep that tab to control OpenClaw."
          : "Copy/paste this URL in a browser on this machine to control OpenClaw.",
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      "Dashboard ready",
    );
  }

  const webSearchProvider = nextConfig.tools?.web?.search?.provider;
  const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
  if (webSearchProvider) {
    const { SEARCH_PROVIDER_OPTIONS, resolveExistingKey, hasExistingKey, hasKeyInEnv } =
      await import("../commands/onboard-search.js");
    const entry = SEARCH_PROVIDER_OPTIONS.find((e) => e.value === webSearchProvider);
    const label = entry?.label ?? webSearchProvider;
    const storedKey = resolveExistingKey(nextConfig, webSearchProvider);
    const keyConfigured = hasExistingKey(nextConfig, webSearchProvider);
    const envAvailable = entry ? hasKeyInEnv(entry) : false;
    const hasKey = keyConfigured || envAvailable;
    const keySource = storedKey
      ? "API key: stored in config."
      : keyConfigured
        ? "API key: configured via secret reference."
        : envAvailable
          ? `API key: provided via ${entry?.envKeys.join(" / ")} env var.`
          : undefined;
    if (webSearchEnabled !== false && hasKey) {
      await prompter.note(
        [
          "Web search is enabled, so your agent can look things up online when needed.",
          "",
          `Provider: ${label}`,
          ...(keySource ? [keySource] : []),
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    } else if (!hasKey) {
      await prompter.note(
        [
          `Provider ${label} is selected but no API key was found.`,
          "web_search will not work until a key is added.",
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          `Get your key at: ${entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web"}`,
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    } else {
      await prompter.note(
        [
          `Web search (${label}) is configured but disabled.`,
          `Re-enable: ${formatCliCommand("openclaw configure --section web")}`,
          "",
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    }
  } else {
    // Legacy configs may have a working key (e.g. apiKey or BRAVE_API_KEY) without
    // an explicit provider. Runtime auto-detects these, so avoid saying "skipped".
    const { SEARCH_PROVIDER_OPTIONS, hasExistingKey, hasKeyInEnv } =
      await import("../commands/onboard-search.js");
    const legacyDetected = SEARCH_PROVIDER_OPTIONS.find(
      (e) => hasExistingKey(nextConfig, e.value) || hasKeyInEnv(e),
    );
    if (legacyDetected) {
      await prompter.note(
        [
          `Web search is available via ${legacyDetected.label} (auto-detected).`,
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    } else {
      await prompter.note(
        [
          "Web search was skipped. You can enable it later:",
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    }
  }

  await prompter.note(
    'What now: https://openclaw.ai/showcase ("What People Are Building").',
    "What now",
  );

  await prompter.outro(
    controlUiOpened
      ? "Onboarding complete. Dashboard opened; keep that tab to control OpenClaw."
      : seededInBackground
        ? "Onboarding complete. Web UI seeded in the background; open it anytime with the dashboard link above."
        : "Onboarding complete. Use the dashboard link above to control OpenClaw.",
  );

  return { launchedTui };
}
