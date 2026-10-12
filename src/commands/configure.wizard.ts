import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import { describeCodexNativeWebSearch } from "../agents/codex-native-web-search.shared.js";
import { formatCliCommand } from "../cli/command-format.js";
import { readConfigFileSnapshotForWrite, resolveGatewayPort } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createChannelSetupHooks, setupChannels } from "../flows/channel-setup.js";
import { validateGatewayPortInput } from "../gateway/gateway-config-prompts.shared.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../gateway/probe-auth.js";
import { parseTcpPort } from "../infra/tcp-port.js";
import { formatWindowsGatewayFirewallGuidance } from "../infra/windows-gateway-firewall-diagnostics.js";
import { resolvePluginContributionOwners } from "../plugins/plugin-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { writeWizardConfigFile } from "../wizard/setup.shared.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon, type DaemonSetupOutcome } from "./configure.daemon.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import {
  runGatewayHealthCheck,
  type GatewayHealthCheckOutcome,
} from "./configure.gateway-health.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import { createConfigurePrompts } from "./configure.prompts.js";
import type { WizardSection } from "./configure.shared.js";
import { CONFIGURE_SECTION_OPTIONS, intro, outro } from "./configure.shared.js";
import { resolveGatewayStartupTiming } from "./gateway-startup-timing.js";
import {
  applyOnboardingWorkspace,
  ensureOnboardingAgentWorkspace,
  resolveOnboardingAgentTarget,
} from "./onboard-agent-target.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  probeGatewayReachable,
  resolveAdvertisedControlUiLinks,
  resolveLocalControlUiProbeLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";
import type { OnboardMode } from "./onboard-types.js";

type ConfigureSectionChoice = WizardSection | "__continue";

const GATEWAY_HINT_PROBE_TIMEOUT_MS = 300;

async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: ReturnType<typeof createClackPrompter>,
): Promise<OpenClawConfig> {
  const prompts = createConfigurePrompts(runtime);
  type WebSearchConfig = NonNullable<NonNullable<OpenClawConfig["tools"]>["web"]>["search"];
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const { isCodexNativeWebSearchRelevant } = await import("../agents/codex-native-web-search.js");
  const hasManagedSearchProviders =
    resolvePluginContributionOwners({
      config: nextConfig,
      contribution: "contracts",
      matches: "webSearchProviders",
    }).length > 0;

  note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Codex-capable models can use native Codex web search.",
      "Other models use a separate web search provider, which you can configure here.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = await prompts.confirm({
    message: "Enable the web_search tool?",
    initialValue: existingSearch?.enabled ?? hasManagedSearchProviders,
  });

  let nextSearch: WebSearchConfig = {
    ...existingSearch,
    enabled: enableSearch,
  };
  let workingConfig = nextConfig;

  if (enableSearch) {
    const codexRelevant = await isCodexNativeWebSearchRelevant({ config: nextConfig });
    let configureManagedProvider = true;

    if (codexRelevant) {
      note(
        [
          "Codex-capable models can use native Codex web search instead of a separate provider.",
          "Other models need a separate web search provider.",
          "If you do not choose one, OpenClaw can select a provider from available credentials; otherwise other models may not have web search.",
          ...(describeCodexNativeWebSearch(nextConfig)
            ? [describeCodexNativeWebSearch(nextConfig)!]
            : []),
        ].join("\n"),
        "Codex native search",
      );

      const enableCodexNative = await prompts.confirm({
        message: "Enable native Codex web search for Codex-capable models?",
        initialValue: existingSearch?.openaiCodex?.enabled === true,
      });

      const codexMode = enableCodexNative
        ? await prompts.select({
            message: "Native Codex web search mode",
            options: [
              {
                value: "cached",
                label: "cached (recommended)",
                hint: "Uses cached web content",
              },
              {
                value: "live",
                label: "live",
                hint: "Allows live external web access",
              },
            ],
            initialValue: existingSearch?.openaiCodex?.mode ?? "cached",
          })
        : undefined;
      nextSearch = {
        ...nextSearch,
        openaiCodex: {
          ...existingSearch?.openaiCodex,
          enabled: enableCodexNative,
          ...(enableCodexNative ? { mode: codexMode } : {}),
        },
      };
      if (enableCodexNative) {
        configureManagedProvider = await prompts.confirm({
          message: existingSearch?.provider
            ? `Change the separate web search provider (currently ${existingSearch.provider})?`
            : "Also configure a separate web search provider for other models?",
          initialValue: Boolean(existingSearch?.provider),
        });
      }
    }

    if (configureManagedProvider) {
      const { resolveSearchProviderOptions, runSearchSetupFlow } =
        await import("../flows/search-setup.js");
      const searchProviderOptions = resolveSearchProviderOptions(nextConfig);
      if (searchProviderOptions.length === 0) {
        note(
          [
            "No web search providers are currently available under this plugin policy.",
            "Enable plugins or remove deny rules, then rerun configure.",
            "Docs: https://docs.openclaw.ai/tools/web",
          ].join("\n"),
          "Web search",
        );
        if (nextSearch.openaiCodex?.enabled !== true) {
          nextSearch = {
            ...existingSearch,
            enabled: false,
          };
        }
      } else {
        const searchSetup = await runSearchSetupFlow(workingConfig, runtime, prompter, {
          preserveDisabledSearchState: false,
        });
        workingConfig = searchSetup.config;
        const selectedSearch = workingConfig.tools?.web?.search;
        nextSearch = {
          ...selectedSearch,
          enabled:
            selectedSearch?.enabled ?? (selectedSearch?.provider ? true : existingSearch?.enabled),
          openaiCodex: {
            ...existingSearch?.openaiCodex,
            ...(nextSearch.openaiCodex as Record<string, unknown> | undefined),
          },
        };
      }
    }
  }

  note(
    [
      "`web_fetch` is a separate tool for reading a specific URL.",
      "It does not require an API key and works independently of web search providers, including Codex.",
    ].join("\n"),
    "Web fetch",
  );

  const enableFetch = await prompts.confirm({
    message: "Enable the web_fetch tool?",
    initialValue: existingFetch?.enabled ?? true,
  });

  const nextFetch = {
    ...workingConfig.tools?.web?.fetch,
    enabled: enableFetch,
  };

  return {
    ...workingConfig,
    tools: {
      ...workingConfig.tools,
      web: {
        ...workingConfig.tools?.web,
        search: nextSearch,
        fetch: nextFetch,
      },
    },
  };
}

/** Run the configure wizard, optionally limited to selected sections. */
export async function runConfigureWizard(
  opts: { sections?: WizardSection[] },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const prompts = createConfigurePrompts(runtime);
  try {
    intro("OpenClaw configure");
    const prompter = createClackPrompter();

    const prepared = await readConfigFileSnapshotForWrite();
    const snapshot = prepared.snapshot;
    // Keep only path ownership across the interactive wizard. Each commit re-reads under
    // the mutation lock and must use that fresh snapshot's env/include conflict facts.
    const configWriteOwnership = {
      ...(prepared.writeOptions.assertConfigPathForWrite
        ? { assertConfigPathForWrite: prepared.writeOptions.assertConfigPathForWrite }
        : {}),
      expectedConfigPath: prepared.writeOptions.expectedConfigPath,
      ownedConfigPathForWrite: prepared.writeOptions.ownedConfigPathForWrite,
    };
    const currentBaseHash = snapshot.hash;
    const baseConfig: OpenClawConfig = snapshot.valid
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {};

    if (snapshot.exists) {
      const title = snapshot.valid ? "Existing config detected" : "Invalid config";
      note(summarizeExistingConfig(baseConfig), title);
      if (!snapshot.valid && snapshot.issues.length > 0) {
        note(
          [
            ...snapshot.issues.map((iss) => `- ${iss.path}: ${iss.message}`),
            "",
            "Docs: https://docs.openclaw.ai/gateway/configuration",
          ].join("\n"),
          "Config issues",
        );
      }
      if (!snapshot.valid) {
        outro(
          `Config invalid. Run \`${formatCliCommand("openclaw doctor --fix")}\` to apply supported repairs, then re-run configure.`,
        );
        runtime.exit(1);
        return;
      }
    }

    const selectedSections = opts.sections;
    const shouldPromptGatewayRunMode =
      !selectedSections ||
      selectedSections.includes("gateway") ||
      selectedSections.includes("daemon") ||
      selectedSections.includes("health");
    const promptGatewayRunMode = async (): Promise<OnboardMode> => {
      const localUrl = `ws://127.0.0.1:${resolveGatewayPort(baseConfig)}`;
      const remoteUrl = normalizeOptionalString(baseConfig.gateway?.remote?.url) ?? "";
      const localProbePromise = (async () => {
        const localProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
          cfg: baseConfig,
          env: process.env,
          mode: "local",
          localPrecedence: "env-first",
        });
        if (localProbeAuth.warning) {
          return { ok: false, authUnavailable: true as const };
        }
        return probeGatewayReachable({
          url: localUrl,
          token: localProbeAuth.auth.token,
          password: localProbeAuth.auth.password,
          timeoutMs: GATEWAY_HINT_PROBE_TIMEOUT_MS,
        });
      })();
      const remoteProbePromise = remoteUrl
        ? (async () => {
            const remoteProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
              cfg: baseConfig,
              env: process.env,
              mode: "remote",
            });
            return probeGatewayReachable({
              url: remoteUrl,
              config: baseConfig,
              originScopedDeviceAuth: true,
              configuredRemote: true,
              token: remoteProbeAuth.auth.token,
              ...(remoteProbeAuth.auth.password ? { password: remoteProbeAuth.auth.password } : {}),
              timeoutMs: GATEWAY_HINT_PROBE_TIMEOUT_MS,
            });
          })()
        : Promise.resolve(null);
      const [localProbe, remoteProbe] = await Promise.all([localProbePromise, remoteProbePromise]);
      return await prompts.select({
        message: "Where will the Gateway run?",
        options: [
          {
            value: "local",
            label: "Local (this machine)",
            hint: localProbe.ok
              ? `Gateway reachable (${localUrl})`
              : "authUnavailable" in localProbe
                ? `Gateway auth unavailable; check skipped (${localUrl})`
                : `No gateway detected (${localUrl})`,
          },
          {
            value: "remote",
            label: "Remote (info-only)",
            hint: !remoteUrl
              ? "No remote URL configured yet"
              : remoteProbe?.ok
                ? `Gateway reachable (${remoteUrl})`
                : `Configured but unreachable (${remoteUrl})`,
          },
        ],
      });
    };

    const mode = shouldPromptGatewayRunMode ? await promptGatewayRunMode() : "local";
    const metadataMode: OnboardMode =
      shouldPromptGatewayRunMode || baseConfig.gateway?.mode !== "remote" ? mode : "remote";
    const shouldSkipGatewaySummary = !shouldPromptGatewayRunMode;

    if (shouldPromptGatewayRunMode && mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: "configure",
        mode: metadataMode,
      });
      const committed = await writeWizardConfigFile(remoteConfig, {
        mergeBase: baseConfig,
        ...(currentBaseHash !== undefined ? { baseHash: currentBaseHash } : {}),
        writeOptions: configWriteOwnership,
      });
      remoteConfig = committed.nextConfig;
      logConfigUpdated(runtime);
      if (selectedSections?.includes("health")) {
        const healthCheckOutcome = await runGatewayHealthCheck({
          cfg: remoteConfig,
          runtime,
          port: resolveGatewayPort(remoteConfig),
        });
        outro(
          healthCheckOutcome === "succeeded"
            ? "Remote gateway configured and health check completed."
            : healthCheckOutcome === "failed"
              ? "Remote gateway configured, but health check failed."
              : "Remote gateway configured; health check skipped.",
        );
      } else {
        outro("Remote gateway configured.");
      }
      return;
    }

    let nextConfig = { ...baseConfig };
    let mergeBaseConfig = structuredClone(baseConfig);
    let hasPendingConfig = shouldPromptGatewayRunMode && nextConfig.gateway?.mode !== "local";
    if (hasPendingConfig) {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
    }
    let setupAgentId: string | undefined;
    const resolveSetupTarget = async () => {
      // Only agent-scoped steps choose an owner; keep that choice across sections.
      setupAgentId ??=
        nextConfig.agents?.ownership === "explicit"
          ? tryResolveAmbientOwnerAgentId(nextConfig)
          : tryResolveLegacyCompatibilityAgentId(nextConfig);
      const agentIds = listAgentIds(nextConfig);
      if (!setupAgentId && agentIds.length > 1) {
        setupAgentId = await prompts.select({
          message: "Which agent do you want to configure?",
          options: agentIds.map((id) => ({ value: id, label: id })),
        });
      }
      return resolveOnboardingAgentTarget(nextConfig, setupAgentId);
    };
    let gatewayPort = resolveGatewayPort(baseConfig);
    let didPersistConfig = false;
    let daemonSetupOutcome: DaemonSetupOutcome | undefined;
    let healthCheckOutcome: GatewayHealthCheckOutcome | undefined;
    const channelSetup = createChannelSetupHooks({ runtime });

    const persistPendingConfig = async () => {
      if (!hasPendingConfig) {
        return;
      }
      nextConfig = applyWizardMetadata(nextConfig, {
        command: "configure",
        mode: metadataMode,
      });

      const committed = await writeWizardConfigFile(nextConfig, {
        mergeBase: mergeBaseConfig,
        writeOptions: configWriteOwnership,
      });
      mergeBaseConfig = structuredClone(committed.nextConfig);
      await channelSetup.runPostWriteHooks(committed.path);
      nextConfig = committed.nextConfig;
      hasPendingConfig = false;
      didPersistConfig = true;
      logConfigUpdated(runtime);
    };

    const configureWorkspace = async () => {
      const target = await resolveSetupTarget();
      const workspaceInput = await prompts.text({
        message: "Workspace directory",
        initialValue: target.workspaceDir,
      });
      const workspaceDir = resolveUserPath(
        normalizeOptionalString(workspaceInput ?? "") || DEFAULT_WORKSPACE,
      );
      if (!snapshot.exists) {
        const indicators = ["MEMORY.md", "memory", ".git"].map((name) =>
          nodePath.join(workspaceDir, name),
        );
        const hasExistingContent = (
          await Promise.all(
            indicators.map(async (candidate) => {
              try {
                await fsPromises.access(candidate);
                return true;
              } catch {
                return false;
              }
            }),
          )
        ).some(Boolean);
        if (hasExistingContent) {
          note(
            [
              `Existing workspace detected at ${workspaceDir}`,
              "Existing files are preserved. Missing templates may be created, never overwritten.",
            ].join("\n"),
            "Existing workspace",
          );
        }
      }
      nextConfig = applyOnboardingWorkspace(nextConfig, target, workspaceDir);
      await ensureOnboardingAgentWorkspace(await resolveSetupTarget(), runtime, {
        skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
        skipOptionalBootstrapFiles: nextConfig.agents?.defaults?.skipOptionalBootstrapFiles,
      });
    };

    const configureChannelsSection = async () => {
      const channelMode = await prompts.select({
        message: "Channel setup",
        options: [
          {
            value: "configure",
            label: "Add or update channels",
            hint: "Configure accounts and disable unselected accounts",
          },
          {
            value: "remove",
            label: "Remove channel config",
            hint: "Delete channel tokens/settings from openclaw.json",
          },
        ],
        initialValue: "configure",
      });
      if (channelMode === "configure") {
        const target = await resolveSetupTarget();
        nextConfig = await setupChannels(nextConfig, runtime, prompter, {
          workspaceDir: target.workspaceDir,
          allowDisable: true,
          allowIMessageInstall: true,
          allowSignalInstall: true,
          deferStatusUntilSelection: true,
          skipConfirm: true,
          skipStatusNote: true,
          onPostWriteHook: channelSetup.onPostWriteHook,
        });
      } else {
        nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
      }
    };

    let didConfigureGateway = false;
    const sectionActions = {
      workspace: configureWorkspace,
      model: async () => {
        nextConfig = await promptAuthConfig(
          nextConfig,
          runtime,
          prompter,
          await resolveSetupTarget(),
        );
      },
      web: async () => {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime, prompter);
      },
      gateway: async () => {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
        didConfigureGateway = true;
      },
      channels: configureChannelsSection,
      plugins: async () => {
        const { configurePluginConfig } = await import("../wizard/setup.plugin-config.js");
        nextConfig = await configurePluginConfig({
          config: nextConfig,
          prompter,
          workspaceDir: (await resolveSetupTarget()).workspaceDir,
        });
      },
      skills: async () => {
        nextConfig = await setupSkills(
          nextConfig,
          (await resolveSetupTarget()).workspaceDir,
          runtime,
          prompter,
        );
      },
      daemon: async () => {
        if (!didConfigureGateway) {
          const portInput = await prompts.text({
            message: "Gateway port for service install",
            initialValue: String(gatewayPort),
            validate: validateGatewayPortInput,
          });
          gatewayPort = parseTcpPort(portInput) ?? gatewayPort;
        }
        daemonSetupOutcome = await maybeInstallDaemon({ runtime, port: gatewayPort });
      },
      health: async () => {
        healthCheckOutcome = await runGatewayHealthCheck({
          cfg: nextConfig,
          runtime,
          port: gatewayPort,
          daemonSetupOutcome,
        });
      },
    } satisfies Record<WizardSection, () => Promise<void>>;

    if (selectedSections) {
      if (selectedSections.length === 0) {
        outro("No configuration changes selected.");
        return;
      }

      // Section flags retain their canonical setup order regardless of flag order;
      // the complete config is committed once before service or health effects.
      for (const section of [
        "workspace",
        "model",
        "web",
        "gateway",
        "channels",
        "plugins",
        "skills",
      ] as const) {
        if (selectedSections.includes(section)) {
          await sectionActions[section]();
          hasPendingConfig = true;
        }
      }

      await persistPendingConfig();

      for (const section of ["daemon", "health"] as const) {
        if (selectedSections.includes(section)) {
          await sectionActions[section]();
        }
      }
    } else {
      let ranSection = false;

      while (true) {
        const choice = await prompts.select<ConfigureSectionChoice>({
          message: "What do you want to configure?",
          options: [
            ...CONFIGURE_SECTION_OPTIONS,
            {
              value: "__continue",
              label: ranSection ? "Done" : "Skip for now",
            },
          ],
          initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
        });
        if (choice === "__continue") {
          break;
        }
        ranSection = true;
        if (choice === "daemon" || choice === "health") {
          await persistPendingConfig();
        }
        await sectionActions[choice]();
        if (choice !== "daemon" && choice !== "health") {
          // Interactive setup commits each section before showing another prompt.
          hasPendingConfig = true;
          await persistPendingConfig();
        }
      }

      if (!ranSection) {
        if (hasPendingConfig) {
          await persistPendingConfig();
          outro("Gateway mode set to local.");
          return;
        }
        outro("No configuration changes selected.");
        return;
      }
    }

    const failedSideEffects = [
      ...(daemonSetupOutcome === "failed" ? ["daemon setup"] : []),
      ...(healthCheckOutcome === "failed" ? ["health check"] : []),
    ];
    let completionMessage = didPersistConfig
      ? "Configuration updated."
      : "No configuration changes selected.";
    if (failedSideEffects.length > 0) {
      completionMessage = `${didPersistConfig ? "Configuration updated" : "Configuration unchanged"}, but ${failedSideEffects.join(" and ")} failed.`;
    } else if (!didPersistConfig && healthCheckOutcome) {
      completionMessage = `Health check ${healthCheckOutcome === "succeeded" ? "completed" : "skipped"}.`;
    } else if (!didPersistConfig && daemonSetupOutcome) {
      completionMessage = `Daemon setup ${daemonSetupOutcome === "succeeded" ? "completed" : "skipped"}.`;
    }

    if (shouldSkipGatewaySummary) {
      const remoteUrl = normalizeOptionalString(nextConfig.gateway?.remote?.url);
      if (remoteUrl) {
        note(
          ["Remote Gateway:", remoteUrl, "Docs: https://docs.openclaw.ai/gateway/remote"].join(
            "\n",
          ),
          "Gateway",
        );
      }
      outro(completionMessage);
      return;
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const linkParams = {
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
      tlsEnabled: nextConfig.gateway?.tls?.enabled === true,
    };
    const displayLinks = await resolveAdvertisedControlUiLinks(linkParams);
    const probeLinks = resolveLocalControlUiProbeLinks(linkParams);
    const probeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
      cfg: nextConfig,
      env: process.env,
      mode: "local",
      localPrecedence: "env-first",
    });
    // Service activation can precede the listener; only a successful daemon action
    // earns the startup grace period, not failed/skipped or config-only work.
    const probe =
      daemonSetupOutcome === "succeeded" ? waitForGatewayReachable : probeGatewayReachable;
    let gatewayProbe = probeAuth.warning
      ? { ok: false, detail: "auth unavailable; check skipped" }
      : await probe({
          ...(daemonSetupOutcome === "succeeded" ? resolveGatewayStartupTiming() : {}),
          url: probeLinks.wsUrl,
          token: probeAuth.auth.token,
          password: probeAuth.auth.password,
        });
    if (!gatewayProbe.ok && !probeAuth.warning && baseConfig.gateway?.auth?.password) {
      const oldProbeAuth = await resolveGatewayProbeAuthSafeWithSecretInputs({
        cfg: baseConfig,
        env: process.env,
        mode: "local",
        localPrecedence: "env-first",
      });
      if (
        !oldProbeAuth.warning &&
        oldProbeAuth.auth.password &&
        probeAuth.auth.password !== oldProbeAuth.auth.password
      ) {
        gatewayProbe = await probeGatewayReachable({
          url: probeLinks.wsUrl,
          token: probeAuth.auth.token,
          password: oldProbeAuth.auth.password,
        });
      }
    }
    const gatewayStatusLine = probeAuth.warning
      ? "Gateway: auth unavailable (check skipped)"
      : gatewayProbe.ok
        ? "Gateway: reachable"
        : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;
    const windowsFirewallLines = formatWindowsGatewayFirewallGuidance({ bind });

    note(
      [
        `Web UI: ${displayLinks.httpUrl}`,
        `Gateway WS: ${displayLinks.wsUrl}`,
        gatewayStatusLine,
        ...windowsFirewallLines,
        "Docs: https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outro(completionMessage);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
