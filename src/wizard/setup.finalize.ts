import fs from "node:fs/promises";
import path from "node:path";
import { describeCodexNativeWebSearch } from "../agents/codex-native-web-search.shared.js";
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
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describeGatewayServiceRestart, resolveGatewayService } from "../daemon/service.js";
import { isSystemdUserServiceAvailable } from "../daemon/systemd.js";
import { cliT } from "../i18n/cli.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { launchTuiCli } from "../tui/tui-launch.js";
import { resolveUserPath } from "../utils.js";
import { listConfiguredWebSearchProviders } from "../web-search/runtime.js";
import type { WizardPrompter } from "./prompts.js";
import { setupWizardShellCompletion } from "./setup.completion.js";
import { resolveSetupSecretInputString } from "./setup.secret-input.js";
import type { GatewayWizardSettings, WizardFlow } from "./setup.types.js";

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

type OnboardSearchModule = typeof import("../commands/onboard-search.js");

let onboardSearchModulePromise: Promise<OnboardSearchModule> | undefined;
const HATCH_TUI_TIMEOUT_MS = 5 * 60 * 1000;

function loadOnboardSearchModule(): Promise<OnboardSearchModule> {
  onboardSearchModulePromise ??= import("../commands/onboard-search.js");
  return onboardSearchModulePromise;
}

export async function finalizeSetupWizard(
  options: FinalizeOnboardingOptions,
): Promise<{ launchedTui: boolean }> {
  const { flow, opts, baseConfig, nextConfig, settings, prompter, runtime } = options;
  const t = (key: Parameters<typeof cliT>[0], vars?: Record<string, string | number>) =>
    cliT(key, process.env, vars);
  let gatewayProbe: { ok: boolean; detail?: string } = { ok: true };
  let resolvedGatewayPassword = "";

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
          installError = t("wizard.gatewayInstallBlockedError", {
            reason: tokenResolution.unavailableReason,
          });
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
        installError = formatErrorMessage(err);
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

  if (settings.authMode === "password") {
    try {
      resolvedGatewayPassword =
        (await resolveSetupSecretInputString({
          config: nextConfig,
          value: nextConfig.gateway?.auth?.password,
          path: "gateway.auth.password",
          env: process.env,
        })) ?? "";
    } catch (error) {
      await prompter.note(
        [t("wizard.gatewayAuthResolveOnboardingAuthError"), formatErrorMessage(error)].join("\n"),
        t("wizard.gatewayAuthTitle"),
      );
    }
  }

  if (!opts.skipHealth) {
    const probeLinks = resolveControlUiLinks({
      bind: nextConfig.gateway?.bind ?? "loopback",
      port: settings.port,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: undefined,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    });
    // Daemon install/restart can briefly flap the WS; wait a bit so health check doesn't false-fail.
    gatewayProbe = await waitForGatewayReachable({
      url: probeLinks.wsUrl,
      token: settings.authMode === "token" ? settings.gatewayToken : undefined,
      password: settings.authMode === "password" ? resolvedGatewayPassword : undefined,
      deadlineMs: 15_000,
    });
    if (gatewayProbe.ok) {
      try {
        const healthConfig: OpenClawConfig =
          settings.authMode === "token" && settings.gatewayToken
            ? {
                ...nextConfig,
                gateway: {
                  ...nextConfig.gateway,
                  auth: {
                    ...nextConfig.gateway?.auth,
                    mode: "token",
                    token: settings.gatewayToken,
                  },
                },
              }
            : nextConfig;
        await healthCommand(
          {
            json: false,
            timeoutMs: 10_000,
            config: healthConfig,
            token: settings.authMode === "token" ? settings.gatewayToken : undefined,
            password: settings.authMode === "password" ? resolvedGatewayPassword : undefined,
          },
          runtime,
        );
      } catch (err) {
        runtime.error(formatHealthCheckFailure(err));
        await prompter.note(
          [t("wizard.healthCheckDocsLine"), t("wizard.healthCheckTroubleshootingLine")].join("\n"),
          t("wizard.healthCheckHelpTitle"),
        );
      }
    } else if (installDaemon) {
      runtime.error(
        formatHealthCheckFailure(
          new Error(
            gatewayProbe.detail ?? `gateway did not become reachable at ${probeLinks.wsUrl}`,
          ),
        ),
      );
      await prompter.note(
        [t("wizard.healthCheckDocsLine"), t("wizard.healthCheckTroubleshootingLine")].join("\n"),
        t("wizard.healthCheckHelpTitle"),
      );
    } else {
      await prompter.note(
        [
          "Gateway not detected yet.",
          "Setup was run without Gateway service install, so no background gateway is expected.",
          `Start now: ${formatCliCommand("openclaw gateway run")}`,
          `Or rerun with: ${formatCliCommand("openclaw onboard --install-daemon")}`,
          `Or skip this probe next time: ${formatCliCommand("openclaw onboard --skip-health")}`,
        ].join("\n"),
        "Gateway",
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
    tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
  });
  const authedUrl =
    settings.authMode === "token" && settings.gatewayToken
      ? `${links.httpUrl}#token=${encodeURIComponent(settings.gatewayToken)}`
      : links.httpUrl;
  if (opts.skipHealth || !gatewayProbe.ok) {
    gatewayProbe = await probeGatewayReachable({
      url: links.wsUrl,
      token: settings.authMode === "token" ? settings.gatewayToken : undefined,
      password: settings.authMode === "password" ? resolvedGatewayPassword : "",
    });
  }
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

  if (!opts.skipUi) {
    if (hasBootstrap) {
      await prompter.note(t("wizard.startTuiBestOptionBody"), t("wizard.startTuiBestOptionTitle"));
    }

    if (gatewayProbe.ok) {
      await prompter.note(
        t("wizard.tokenInfoBody", {
          viewTokenCommand: formatCliCommand("openclaw config get gateway.auth.token"),
          generateTokenCommand: formatCliCommand("openclaw doctor --generate-gateway-token"),
          openDashboardCommand: formatCliCommand("openclaw dashboard --no-open"),
        }),
        t("wizard.tokenTitle"),
      );
    }

    const hatchOptions: { value: "tui" | "web" | "later"; label: string }[] = [
      { value: "tui", label: t("wizard.hatchOptionTui") },
      ...(gatewayProbe.ok ? [{ value: "web" as const, label: t("wizard.hatchOptionWeb") }] : []),
      { value: "later", label: t("wizard.hatchOptionLater") },
    ];

    hatchChoice = await prompter.select({
      message: t("wizard.hatchQuestion"),
      options: hatchOptions,
      initialValue: "tui",
    });

    if (hatchChoice === "tui") {
      restoreTerminalState("pre-setup tui", { resumeStdinIfPaused: true });
      try {
        await launchTuiCli({
          local: true,
          deliver: false,
          message: hasBootstrap ? t("wizard.hatchWakeMessage") : undefined,
          timeoutMs: HATCH_TUI_TIMEOUT_MS,
        });
      } finally {
        restoreTerminalState("post-setup tui", { resumeStdinIfPaused: true });
      }
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

  await setupWizardShellCompletion({ flow, prompter });

  const shouldOpenControlUi =
    !opts.skipUi &&
    gatewayProbe.ok &&
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

  const codexNativeSummary = describeCodexNativeWebSearch(nextConfig);
  const webSearchProvider = nextConfig.tools?.web?.search?.provider;
  const webSearchEnabled = nextConfig.tools?.web?.search?.enabled;
  const configuredSearchProviders = listConfiguredWebSearchProviders({ config: nextConfig });
  if (webSearchProvider) {
    const { resolveExistingKey, hasExistingKey, hasKeyInEnv } = await loadOnboardSearchModule();
    const entry = configuredSearchProviders.find((e) => e.id === webSearchProvider);
    const label = entry?.label ?? webSearchProvider;
    const storedKey = entry ? resolveExistingKey(nextConfig, webSearchProvider) : undefined;
    const keyConfigured = entry ? hasExistingKey(nextConfig, webSearchProvider) : false;
    const envAvailable = entry ? hasKeyInEnv(entry) : false;
    const hasKey = keyConfigured || envAvailable;
    const keySource = storedKey
      ? t("wizard.webSearchApiKeyStoredInConfigSimple")
      : keyConfigured
        ? t("wizard.webSearchApiKeyConfiguredViaSecretRef")
        : envAvailable
          ? t("wizard.webSearchApiKeyProvidedViaEnvVarsLine", {
              envVars: entry?.envVars.join(" / ") ?? "",
            })
          : undefined;
    if (!entry) {
      await prompter.note(
        [
          `Web search provider ${label} is selected but unavailable under the current plugin policy.`,
          "web_search will not work until the provider is re-enabled or a different provider is selected.",
          `  ${formatCliCommand("openclaw configure --section web")}`,
          "",
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    } else if (webSearchEnabled !== false && hasKey) {
      await prompter.note(
        [
          t("wizard.webSearchEnabledIntro"),
          "",
          t("wizard.webSearchProviderLine", { provider: label }),
          ...(keySource ? [keySource] : []),
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchTitle"),
      );
    } else if (!hasKey) {
      await prompter.note(
        [
          t("wizard.webSearchProviderSelectedNoApiKeyLine", { provider: label }),
          t("wizard.webSearchWillNotWorkUntilKeyLine"),
          t("wizard.webSearchRunConfigureWebIndentedLine", {
            command: formatCliCommand("openclaw configure --section web"),
          }),
          "",
          t("wizard.webSearchGetKeyAtLine", {
            url: entry?.signupUrl ?? "https://docs.openclaw.ai/tools/web",
          }),
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchTitle"),
      );
    } else {
      await prompter.note(
        [
          t("wizard.webSearchConfiguredButDisabledLine", { provider: label }),
          t("wizard.webSearchReenableLine", {
            command: formatCliCommand("openclaw configure --section web"),
          }),
          "",
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchTitle"),
      );
    }
  } else {
    // Legacy configs may have a working key (e.g. apiKey or BRAVE_API_KEY) without
    // an explicit provider. Runtime auto-detects these, so avoid saying "skipped".
    const { hasExistingKey, hasKeyInEnv } = await loadOnboardSearchModule();
    const legacyDetected = configuredSearchProviders.find(
      (e) => hasExistingKey(nextConfig, e.id) || hasKeyInEnv(e),
    );
    if (legacyDetected) {
      await prompter.note(
        [
          t("wizard.webSearchAutoDetectedLine", { provider: legacyDetected.label }),
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchTitle"),
      );
    } else if (codexNativeSummary) {
      await prompter.note(
        [
          "Managed web search provider was skipped.",
          codexNativeSummary,
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    } else {
      await prompter.note(
        [
          t("wizard.webSearchSkippedEnableLaterLine"),
          t("wizard.webSearchRunConfigureWebIndentedLine", {
            command: formatCliCommand("openclaw configure --section web"),
          }),
          "",
          t("wizard.webSearchDocsLine"),
        ].join("\n"),
        t("wizard.webSearchTitle"),
      );
    }
  }

  if (codexNativeSummary) {
    await prompter.note(
      [
        codexNativeSummary,
        "Used only for Codex-capable models.",
        "Docs: https://docs.openclaw.ai/tools/web",
      ].join("\n"),
      "Codex native search",
    );
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
