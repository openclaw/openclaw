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
  resolveControlUiLinks,
} from "../commands/onboard-helpers.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { OpenClawConfig } from "../config/config.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { cliT } from "../i18n/cli.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { runTui } from "../tui/tui.js";
import { resolveUserPath } from "../utils.js";
import { setupOnboardingShellCompletion } from "./onboarding.completion.js";
import { resolveOnboardingSecretInputString } from "./onboarding.secret-input.js";
import type { GatewayWizardSettings, WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type FinalizeOnboardingOptions = {
  flow: WizardFlow;
  opts: OnboardOptions;
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  workspaceDir: string;
  settings: GatewayWizardSettings;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
};

export async function finalizeOnboardingWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
  const t = (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) =>
    cliT(key, process.env, vars);

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
    await prompter.note(t("wizard.systemdUnavailableNote"), t("wizard.systemdTitle"));
  }

  if (process.platform === "linux" && systemdAvailable) {
    const { ensureSystemdUserLingerInteractive } = await import("../commands/systemd-linger.js");
    await ensureSystemdUserLingerInteractive({
      runtime,
      prompter: {
        confirm: prompter.confirm,
        note: prompter.note,
      },
      reason: t("wizard.systemdLingerReason"),
      requireConfirm: false,
    });
  }

  const explicitInstallDaemon =
    typeof opts.installDaemon === "boolean" ? opts.installDaemon : undefined;
  let installDaemon: boolean;
  if (explicitInstallDaemon !== undefined) {
    installDaemon = explicitInstallDaemon;
  } else if (process.platform === "linux" && !systemdAvailable) {
    installDaemon = false;
  } else if (flow === "quickstart") {
    installDaemon = true;
  } else {
    installDaemon = await prompter.confirm({
      message: t("wizard.installGatewayServiceQuestion"),
      initialValue: true,
    });
  }

  if (process.platform === "linux" && !systemdAvailable && installDaemon) {
    await prompter.note(
      t("wizard.systemdUnavailableServiceInstallNote"),
      t("wizard.gatewayServiceTitle"),
    );
    installDaemon = false;
  }

  if (installDaemon) {
    const daemonRuntime =
      flow === "quickstart"
        ? DEFAULT_GATEWAY_DAEMON_RUNTIME
        : await prompter.select({
            message: t("wizard.gatewayServiceRuntimeQuestion"),
            options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
            initialValue: opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
          });
    if (flow === "quickstart") {
      await prompter.note(
        t("wizard.quickstartGatewayRuntimeNodeNote"),
        t("wizard.gatewayServiceRuntimeQuestion"),
      );
    }
    const service = resolveGatewayService();
    const loaded = await service.isLoaded({ env: process.env });
    let restartWasScheduled = false;
    if (loaded) {
      const action = await prompter.select({
        message: t("wizard.gatewayServiceAlreadyInstalledQuestion"),
        options: [
          { value: "restart", label: t("wizard.gatewayServiceActionRestart") },
          { value: "reinstall", label: t("wizard.gatewayServiceActionReinstall") },
          { value: "skip", label: t("wizard.gatewayServiceActionSkip") },
        ],
      });
      if (action === "restart") {
        let restartDoneMessage = t("wizard.gatewayServiceRestartedDone");
        await withWizardProgress(
          t("wizard.gatewayServiceTitle"),
          { doneMessage: () => restartDoneMessage },
          async (progress) => {
            progress.update(t("wizard.gatewayServiceRestartingProgress"));
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
          t("wizard.gatewayServiceTitle"),
          { doneMessage: t("wizard.gatewayServiceUninstalledDone") },
          async (progress) => {
            progress.update(t("wizard.gatewayServiceUninstallingProgress"));
            await service.uninstall({ env: process.env, stdout: process.stdout });
          },
        );
      }
    }

    if (
      !loaded ||
      (!restartWasScheduled && loaded && !(await service.isLoaded({ env: process.env })))
    ) {
      const progress = prompter.progress(t("wizard.gatewayServiceTitle"));
      let installError: string | null = null;
      try {
        progress.update(t("wizard.gatewayServicePreparingProgress"));
        const tokenResolution = await resolveGatewayInstallToken({
          config: nextConfig,
          env: process.env,
        });
        for (const warning of tokenResolution.warnings) {
          await prompter.note(warning, t("wizard.gatewayServiceTitle"));
        }
        if (tokenResolution.unavailableReason) {
          installError = [
            "Gateway install blocked:",
            tokenResolution.unavailableReason,
            "Fix gateway auth config/token input and rerun onboarding.",
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

          progress.update(t("wizard.gatewayServiceInstallingProgress"));
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
          installError
            ? t("wizard.gatewayServiceInstallFailedDone")
            : t("wizard.gatewayServiceInstalledDone"),
        );
      }
      if (installError) {
        await prompter.note(
          t("wizard.gatewayServiceInstallFailedPrefix", { error: installError }),
          t("wizard.gatewayTitle"),
        );
        await prompter.note(gatewayInstallErrorHint(), t("wizard.gatewayTitle"));
      }
    }
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.gatewayToken,
      deadlineMs: 15_000,
    });
    try {
      await healthCommand({ json: false, timeoutMs: 10_000 }, runtime);
    } catch (err) {
      runtime.error(formatHealthCheckFailure(err));
      await prompter.note(
        [t("wizard.healthCheckDocsLine"), t("wizard.healthCheckTroubleshootingLine")].join("\n"),
        t("wizard.healthCheckHelpTitle"),
      );
    }
  }

  const controlUiEnabled =
    nextConfig.gateway?.controlUi?.enabled ?? baseConfig.gateway?.controlUi?.enabled ?? true;
  if (!opts.skipUi && controlUiEnabled) {
    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }
  }

  await prompter.note(t("wizard.optionalAppsBody"), t("wizard.optionalAppsTitle"));

  const controlUiBasePath =
    nextConfig.gateway?.controlUi?.basePath ?? baseConfig.gateway?.controlUi?.basePath;
  const links = resolveControlUiLinks({
    bind: settings.bind,
    port: settings.port,
    customBindHost: settings.customBindHost,
    basePath: controlUiBasePath,
  });
  const authedUrl =
    settings.authMode === "token" && settings.gatewayToken
      ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}`
      : links.httpUrl;
  let resolvedGatewayPassword = "";
  if (settings.authMode === "password") {
    try {
      resolvedGatewayPassword =
        (await resolveOnboardingSecretInputString({
          config: nextConfig,
          value: nextConfig.gateway?.auth?.password,
          path: "gateway.auth.password",
          env: process.env,
        })) ?? "";
    } catch (error) {
      await prompter.note(
        [
          t("wizard.gatewayAuthResolveOnboardingAuthError"),
          error instanceof Error ? error.message : String(error),
        ].join("\n"),
        t("wizard.gatewayAuthTitle"),
      );
    }
  }

  const gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token: settings.authMode === "token" ? settings.gatewayToken : undefined,
    password: settings.authMode === "password" ? resolvedGatewayPassword : "",
  });
  const gatewayStatusLine = gatewayProbe.ok
    ? t("wizard.controlUiGatewayStatusReachable")
    : gatewayProbe.detail
      ? t("wizard.controlUiGatewayStatusNotDetectedWithDetail", { detail: gatewayProbe.detail })
      : t("wizard.controlUiGatewayStatusNotDetected");
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
      t("wizard.controlUiWebUiLine", { url: links.httpUrl }),
      settings.authMode === "token" && settings.gatewayToken
        ? t("wizard.controlUiWebUiWithTokenLine", { url: authedUrl })
        : undefined,
      t("wizard.controlUiGatewayWsLine", { url: links.wsUrl }),
      gatewayStatusLine,
      t("wizard.controlUiDocsLine"),
    ]
      .filter(Boolean)
      .join("\n"),
    t("wizard.controlUiTitle"),
  );

  let controlUiOpened = false;
  let controlUiOpenHint: string | undefined;
  let seededInBackground = false;
  let hatchChoice: "tui" | "web" | "later" | null = null;
  let launchedTui = false;

  if (!opts.skipUi && gatewayProbe.ok) {
    if (hasBootstrap) {
      await prompter.note(t("wizard.startTuiBestOptionBody"), t("wizard.startTuiBestOptionTitle"));
    }

    await prompter.note(
      t("wizard.tokenInfoBody", {
        viewTokenCommand: formatCliCommand("openclaw config get gateway.auth.token"),
        generateTokenCommand: formatCliCommand("openclaw doctor --generate-gateway-token"),
        openDashboardCommand: formatCliCommand("openclaw dashboard --no-open"),
      }),
      t("wizard.tokenTitle"),
    );

    hatchChoice = await prompter.select({
      message: t("wizard.hatchQuestion"),
      options: [
        { value: "tui", label: t("wizard.hatchOptionTui") },
        { value: "web", label: t("wizard.hatchOptionWeb") },
        { value: "later", label: t("wizard.hatchOptionLater") },
      ],
      initialValue: "tui",
    });

    if (hatchChoice === "tui") {
      restoreTerminalState("pre-onboarding tui", { resumeStdinIfPaused: true });
      await runTui({
        url: links.wsUrl,
        token: settings.authMode === "token" ? settings.gatewayToken : undefined,
        password: settings.authMode === "password" ? resolvedGatewayPassword : "",
        // Safety: onboarding TUI should not auto-deliver to lastProvider/lastTo.
        deliver: false,
        message: hasBootstrap ? t("wizard.hatchWakeMessage") : undefined,
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
          t("wizard.dashboardLinkWithTokenLine", { url: authedUrl }),
          controlUiOpened ? t("wizard.dashboardOpenedLine") : t("wizard.dashboardCopyLine"),
          controlUiOpenHint,
        ]
          .filter(Boolean)
          .join("\n"),
        t("wizard.dashboardReadyTitle"),
      );
    } else {
      await prompter.note(
        t("wizard.laterCommandLine", {
          command: formatCliCommand("openclaw dashboard --no-open"),
        }),
        t("wizard.laterTitle"),
      );
    }
  } else if (opts.skipUi) {
    await prompter.note(t("wizard.skipControlUiPromptsNote"), t("wizard.controlUiTitle"));
  }

  await prompter.note(t("wizard.workspaceBackupBody"), t("wizard.workspaceBackupTitle"));

  await prompter.note(t("wizard.securityReminderBody"), t("wizard.securityTitle"));

  await setupOnboardingShellCompletion({ flow, prompter });

  const shouldOpenControlUi =
    !opts.skipUi &&
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
        t("wizard.dashboardLinkWithTokenLine", { url: authedUrl }),
        controlUiOpened ? t("wizard.dashboardOpenedLine") : t("wizard.dashboardCopyLine"),
        controlUiOpenHint,
      ]
        .filter(Boolean)
        .join("\n"),
      t("wizard.dashboardReadyTitle"),
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
    const providerPath =
      webSearchProvider === "perplexity"
        ? "tools.web.search.perplexity.apiKey"
        : webSearchProvider === "gemini"
          ? "tools.web.search.gemini.apiKey"
          : webSearchProvider === "grok"
            ? "tools.web.search.grok.apiKey"
            : webSearchProvider === "kimi"
              ? "tools.web.search.kimi.apiKey"
              : "tools.web.search.apiKey";
    const keySource = storedKey
      ? t("wizard.webSearchApiKeyStoredInConfigLine", { path: providerPath })
      : keyConfigured
        ? "API key: configured via secret reference."
        : envAvailable
          ? t("wizard.webSearchApiKeyProvidedViaEnvLine", {
              envVar: entry?.envKeys.join(" / ") ?? "",
            })
          : undefined;
    if (webSearchEnabled !== false && hasKey) {
      await prompter.note(
        [
          t("wizard.webSearchEnabledIntro"),
          "",
          t("wizard.webSearchProviderLine", { provider: label }),
          ...(keySource ? [keySource] : []),
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchOptionalTitle"),
      );
    } else if (!hasKey) {
      await prompter.note(
        [
          `Provider ${label} is selected but no API key was found.`,
          "web_search will not work until a key is added.",
          t("wizard.webSearchRunConfigureWebLine", {
            command: formatCliCommand("openclaw configure --section web"),
          }),
          "",
          `Get your key at: ${entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web"}`,
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchOptionalTitle"),
      );
    } else {
      await prompter.note(
        [
          `Web search (${label}) is configured but disabled.`,
          `Re-enable: ${formatCliCommand("openclaw configure --section web")}`,
          "",
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchOptionalTitle"),
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
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchOptionalTitle"),
      );
    } else {
      await prompter.note(
        [
          "Web search was skipped. You can enable it later:",
          t("wizard.webSearchRunConfigureWebLine", {
            command: formatCliCommand("openclaw configure --section web"),
          }),
          "",
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchOptionalTitle"),
      );
    }
  }

  await prompter.note(t("wizard.whatNowBody"), t("wizard.whatNowTitle"));

  await prompter.outro(
    controlUiOpened
      ? t("wizard.outroDashboardOpened")
      : seededInBackground
        ? t("wizard.outroSeededBackground")
        : t("wizard.outroComplete"),
  );

  return { launchedTui };
}
