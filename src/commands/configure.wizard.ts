import fsPromises from "node:fs/promises";
import nodePath from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot, resolveGatewayPort, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { AgentCortexConfig } from "../config/types.agent-defaults.js";
import { ensureControlUiAssetsBuilt } from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { resolveSetupSecretInputString } from "../wizard/setup.secret-input.js";
import { removeChannelConfigWizard } from "./configure.channels.js";
import { maybeInstallDaemon } from "./configure.daemon.js";
import { promptAuthConfig } from "./configure.gateway-auth.js";
import { promptGatewayConfig } from "./configure.gateway.js";
import type {
  ChannelsWizardMode,
  ConfigureWizardParams,
  WizardSection,
} from "./configure.shared.js";
import {
  CONFIGURE_SECTION_OPTIONS,
  confirm,
  intro,
  outro,
  select,
  text,
} from "./configure.shared.js";
import { formatHealthCheckFailure } from "./health-format.js";
import { healthCommand } from "./health.js";
import { noteChannelStatus, setupChannels } from "./onboard-channels.js";
import {
  applyWizardMetadata,
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
  guardCancel,
  printWizardHeader,
  probeGatewayReachable,
  resolveControlUiLinks,
  summarizeExistingConfig,
  waitForGatewayReachable,
} from "./onboard-helpers.js";
import { promptRemoteGatewayConfig } from "./onboard-remote.js";
import { setupSkills } from "./onboard-skills.js";

type ConfigureSectionChoice = WizardSection | "__continue";
type CortexMode = NonNullable<AgentCortexConfig["mode"]>;

async function resolveGatewaySecretInputForWizard(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  try {
    return await resolveSetupSecretInputString({
      config: params.cfg,
      value: params.value,
      path: params.path,
      env: process.env,
    });
  } catch {
    return undefined;
  }
}

async function runGatewayHealthCheck(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  port: number;
}): Promise<void> {
  const localLinks = resolveControlUiLinks({
    bind: params.cfg.gateway?.bind ?? "loopback",
    port: params.port,
    customBindHost: params.cfg.gateway?.customBindHost,
    basePath: undefined,
  });
  const remoteUrl = params.cfg.gateway?.remote?.url?.trim();
  const wsUrl = params.cfg.gateway?.mode === "remote" && remoteUrl ? remoteUrl : localLinks.wsUrl;
  const configuredToken = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
  });
  const configuredPassword = await resolveGatewaySecretInputForWizard({
    cfg: params.cfg,
    value: params.cfg.gateway?.auth?.password,
    path: "gateway.auth.password",
  });
  const token =
    process.env.OPENCLAW_GATEWAY_TOKEN ?? process.env.CLAWDBOT_GATEWAY_TOKEN ?? configuredToken;
  const password =
    process.env.OPENCLAW_GATEWAY_PASSWORD ??
    process.env.CLAWDBOT_GATEWAY_PASSWORD ??
    configuredPassword;

  await waitForGatewayReachable({
    url: wsUrl,
    token,
    password,
    deadlineMs: 15_000,
  });

  try {
    await healthCommand({ json: false, timeoutMs: 10_000 }, params.runtime);
  } catch (err) {
    params.runtime.error(formatHealthCheckFailure(err));
    note(
      [
        "Docs:",
        "https://docs.openclaw.ai/gateway/health",
        "https://docs.openclaw.ai/gateway/troubleshooting",
      ].join("\n"),
      "Health check help",
    );
  }
}

async function promptConfigureSection(
  runtime: RuntimeEnv,
  hasSelection: boolean,
): Promise<ConfigureSectionChoice> {
  return guardCancel(
    await select<ConfigureSectionChoice>({
      message: "Select sections to configure",
      options: [
        ...CONFIGURE_SECTION_OPTIONS,
        {
          value: "__continue",
          label: "Continue",
          hint: hasSelection ? "Done" : "Skip for now",
        },
      ],
      initialValue: CONFIGURE_SECTION_OPTIONS[0]?.value,
    }),
    runtime,
  );
}

async function promptChannelMode(runtime: RuntimeEnv): Promise<ChannelsWizardMode> {
  return guardCancel(
    await select({
      message: "Channels",
      options: [
        {
          value: "configure",
          label: "Configure/link",
          hint: "Add/update channels; disable unselected accounts",
        },
        {
          value: "remove",
          label: "Remove channel config",
          hint: "Delete channel tokens/settings from openclaw.json",
        },
      ],
      initialValue: "configure",
    }),
    runtime,
  ) as ChannelsWizardMode;
}

async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const {
    resolveSearchProviderOptions,
    resolveExistingKey,
    hasExistingKey,
    applySearchKey,
    applySearchProviderSelection,
    hasKeyInEnv,
  } = await import("./onboard-search.js");
  const searchProviderOptions = resolveSearchProviderOptions(nextConfig);
  const defaultProvider = searchProviderOptions[0]?.id;

  const hasKeyForProvider = (provider: string): boolean => {
    const entry = searchProviderOptions.find((e) => e.id === provider);
    if (!entry) {
      return false;
    }
    return hasExistingKey(nextConfig, provider) || hasKeyInEnv(entry);
  };

  const existingProvider = (() => {
    const stored = existingSearch?.provider;
    if (stored && searchProviderOptions.some((e) => e.id === stored)) {
      return stored;
    }
    return searchProviderOptions.find((e) => hasKeyForProvider(e.id))?.id ?? defaultProvider;
  })();

  note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "Choose a provider and paste your API key.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = guardCancel(
    await confirm({
      message: "Enable web_search?",
      initialValue:
        existingSearch?.enabled ?? searchProviderOptions.some((e) => hasKeyForProvider(e.id)),
    }),
    runtime,
  );

  let nextSearch: Record<string, unknown> = {
    ...existingSearch,
    enabled: enableSearch,
  };
  let workingConfig = nextConfig;

  if (enableSearch) {
    if (searchProviderOptions.length === 0) {
      note(
        [
          "No web search providers are currently available under this plugin policy.",
          "Enable plugins or remove deny rules, then rerun configure.",
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
      nextSearch = {
        ...existingSearch,
        enabled: false,
      };
    } else {
      const providerOptions = searchProviderOptions.map((entry) => {
        const configured = hasKeyForProvider(entry.id);
        return {
          value: entry.id,
          label: entry.label,
          hint: configured ? `${entry.hint} · configured` : entry.hint,
        };
      });

      const providerChoice = guardCancel(
        await select({
          message: "Choose web search provider",
          options: providerOptions,
          initialValue: existingProvider,
        }),
        runtime,
      );

      nextSearch = { ...nextSearch, provider: providerChoice };

      const entry = searchProviderOptions.find((e) => e.id === providerChoice)!;
      const existingKey = resolveExistingKey(nextConfig, providerChoice);
      const keyConfigured = hasExistingKey(nextConfig, providerChoice);
      const envAvailable = entry.envVars.some((k) => Boolean(process.env[k]?.trim()));
      const envVarNames = entry.envVars.join(" / ");

      const keyInput = guardCancel(
        await text({
          message: keyConfigured
            ? envAvailable
              ? `${entry.label} API key (leave blank to keep current or use ${envVarNames})`
              : `${entry.label} API key (leave blank to keep current)`
            : envAvailable
              ? `${entry.label} API key (paste it here; leave blank to use ${envVarNames})`
              : `${entry.label} API key`,
          placeholder: keyConfigured ? "Leave blank to keep current" : entry.placeholder,
        }),
        runtime,
      );
      const key = String(keyInput ?? "").trim();

      if (key || existingKey) {
        workingConfig = applySearchKey(workingConfig, providerChoice, (key || existingKey)!);
        nextSearch = { ...workingConfig.tools?.web?.search };
      } else if (keyConfigured || envAvailable) {
        workingConfig = applySearchProviderSelection(workingConfig, providerChoice);
        nextSearch = { ...workingConfig.tools?.web?.search };
      } else {
        nextSearch = { ...nextSearch, provider: providerChoice };
        note(
          [
            "No key stored yet — web_search won't work until a key is available.",
            `Store a key here or set ${envVarNames} in the Gateway environment.`,
            `Get your API key at: ${entry.signupUrl}`,
            "Docs: https://docs.openclaw.ai/tools/web",
          ].join("\n"),
          "Web search",
        );
      }
    }
  }

  const enableFetch = guardCancel(
    await confirm({
      message: "Enable web_fetch (keyless HTTP fetch)?",
      initialValue: existingFetch?.enabled ?? true,
    }),
    runtime,
  );

  const nextFetch = {
    ...existingFetch,
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

async function promptCortexMemoryConfig(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
  workspaceDir: string,
): Promise<OpenClawConfig> {
  const existing: AgentCortexConfig | undefined = nextConfig.agents?.defaults?.cortex;
  const defaultGraphPath = nodePath.join(workspaceDir, ".cortex", "context.json");
  const graphExists = await fsPromises
    .access(defaultGraphPath)
    .then(() => true)
    .catch(() => false);

  note(
    [
      "Cortex can prepend a filtered local memory graph into agent system prompts.",
      `Default workspace graph: ${defaultGraphPath}`,
      graphExists
        ? "A local Cortex graph was detected in this workspace."
        : "No default Cortex graph was detected yet; you can still enable the bridge now.",
    ].join("\n"),
    "Cortex memory",
  );

  const enable = guardCancel(
    await confirm({
      message: "Enable Cortex prompt bridge?",
      initialValue: existing?.enabled ?? graphExists,
    }),
    runtime,
  );

  if (!enable) {
    return {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          cortex: {
            ...existing,
            enabled: false,
          },
        },
      },
    };
  }

  const mode = guardCancel(
    await select({
      message: "Cortex prompt mode",
      options: [
        { value: "technical", label: "Technical", hint: "Project and coding context" },
        { value: "professional", label: "Professional", hint: "Work-safe context slice" },
        { value: "minimal", label: "Minimal", hint: "Smallest safe context" },
        { value: "full", label: "Full", hint: "Largest context slice" },
      ],
      initialValue: existing?.mode ?? "technical",
    }),
    runtime,
  ) as CortexMode;

  const maxCharsInput = guardCancel(
    await text({
      message: "Cortex max prompt chars",
      initialValue: String(existing?.maxChars ?? 1500),
      validate: (value) => {
        const parsed = Number.parseInt(String(value), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return "Enter a positive integer";
        }
        return undefined;
      },
    }),
    runtime,
  );
  const maxChars = Number.parseInt(String(maxCharsInput), 10);

  const useDefaultGraph = guardCancel(
    await confirm({
      message: "Use the default workspace Cortex graph path?",
      initialValue: !existing?.graphPath,
    }),
    runtime,
  );

  let graphPath: string | undefined;
  if (!useDefaultGraph) {
    const graphInput = guardCancel(
      await text({
        message: "Cortex graph path",
        initialValue: existing?.graphPath ?? defaultGraphPath,
      }),
      runtime,
    );
    const trimmed = String(graphInput ?? "").trim();
    graphPath = trimmed || defaultGraphPath;
  }

  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      defaults: {
        ...nextConfig.agents?.defaults,
        cortex: {
          ...existing,
          enabled: true,
          mode,
          maxChars,
          ...(graphPath ? { graphPath } : {}),
        },
      },
    },
  };
}

export async function runConfigureWizard(
  opts: ConfigureWizardParams,
  runtime: RuntimeEnv = defaultRuntime,
) {
  try {
    printWizardHeader(runtime);
    intro(opts.command === "update" ? "OpenClaw update wizard" : "OpenClaw configure");
    const prompter = createClackPrompter();

    const snapshot = await readConfigFileSnapshot();
    const baseConfig: OpenClawConfig = snapshot.valid ? snapshot.config : {};

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
          `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run configure.`,
        );
        runtime.exit(1);
        return;
      }
    }

    const localUrl = "ws://127.0.0.1:18789";
    const baseLocalProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.token,
      path: "gateway.auth.token",
    });
    const baseLocalProbePassword = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.auth?.password,
      path: "gateway.auth.password",
    });
    const localProbe = await probeGatewayReachable({
      url: localUrl,
      token:
        process.env.OPENCLAW_GATEWAY_TOKEN ??
        process.env.CLAWDBOT_GATEWAY_TOKEN ??
        baseLocalProbeToken,
      password:
        process.env.OPENCLAW_GATEWAY_PASSWORD ??
        process.env.CLAWDBOT_GATEWAY_PASSWORD ??
        baseLocalProbePassword,
    });
    const remoteUrl = baseConfig.gateway?.remote?.url?.trim() ?? "";
    const baseRemoteProbeToken = await resolveGatewaySecretInputForWizard({
      cfg: baseConfig,
      value: baseConfig.gateway?.remote?.token,
      path: "gateway.remote.token",
    });
    const remoteProbe = remoteUrl
      ? await probeGatewayReachable({
          url: remoteUrl,
          token: baseRemoteProbeToken,
        })
      : null;

    const mode = guardCancel(
      await select({
        message: "Where will the Gateway run?",
        options: [
          {
            value: "local",
            label: "Local (this machine)",
            hint: localProbe.ok
              ? `Gateway reachable (${localUrl})`
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
      }),
      runtime,
    );

    if (mode === "remote") {
      let remoteConfig = await promptRemoteGatewayConfig(baseConfig, prompter);
      remoteConfig = applyWizardMetadata(remoteConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(remoteConfig);
      logConfigUpdated(runtime);
      outro("Remote gateway configured.");
      return;
    }

    let nextConfig = { ...baseConfig };
    let didSetGatewayMode = false;
    if (nextConfig.gateway?.mode !== "local") {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...nextConfig.gateway,
          mode: "local",
        },
      };
      didSetGatewayMode = true;
    }
    let workspaceDir =
      nextConfig.agents?.defaults?.workspace ??
      baseConfig.agents?.defaults?.workspace ??
      DEFAULT_WORKSPACE;
    let gatewayPort = resolveGatewayPort(baseConfig);

    const persistConfig = async () => {
      nextConfig = applyWizardMetadata(nextConfig, {
        command: opts.command,
        mode,
      });
      await writeConfigFile(nextConfig);
      logConfigUpdated(runtime);
    };

    const configureWorkspace = async () => {
      const workspaceInput = guardCancel(
        await text({
          message: "Workspace directory",
          initialValue: workspaceDir,
        }),
        runtime,
      );
      workspaceDir = resolveUserPath(String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE);
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
      nextConfig = {
        ...nextConfig,
        agents: {
          ...nextConfig.agents,
          defaults: {
            ...nextConfig.agents?.defaults,
            workspace: workspaceDir,
          },
        },
      };
      await ensureWorkspaceAndSessions(workspaceDir, runtime);
    };

    const configureChannelsSection = async () => {
      await noteChannelStatus({ cfg: nextConfig, prompter });
      const channelMode = await promptChannelMode(runtime);
      if (channelMode === "configure") {
        nextConfig = await setupChannels(nextConfig, runtime, prompter, {
          allowDisable: true,
          allowSignalInstall: true,
          skipConfirm: true,
          skipStatusNote: true,
        });
      } else {
        nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
      }
    };

    const promptDaemonPort = async () => {
      const portInput = guardCancel(
        await text({
          message: "Gateway port for service install",
          initialValue: String(gatewayPort),
          validate: (value) => (Number.isFinite(Number(value)) ? undefined : "Invalid port"),
        }),
        runtime,
      );
      gatewayPort = Number.parseInt(String(portInput), 10);
    };

    if (opts.sections) {
      const selected = opts.sections;
      if (!selected || selected.length === 0) {
        outro("No changes selected.");
        return;
      }

      if (selected.includes("workspace")) {
        await configureWorkspace();
      }

      if (selected.includes("model")) {
        nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
      }

      if (selected.includes("web")) {
        nextConfig = await promptWebToolsConfig(nextConfig, runtime);
      }

      if (selected.includes("memory")) {
        nextConfig = await promptCortexMemoryConfig(nextConfig, runtime, workspaceDir);
      }

      if (selected.includes("gateway")) {
        const gateway = await promptGatewayConfig(nextConfig, runtime);
        nextConfig = gateway.config;
        gatewayPort = gateway.port;
      }

      if (selected.includes("channels")) {
        await configureChannelsSection();
      }

      if (selected.includes("skills")) {
        const wsDir = resolveUserPath(workspaceDir);
        nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
      }

      await persistConfig();

      if (selected.includes("daemon")) {
        if (!selected.includes("gateway")) {
          await promptDaemonPort();
        }

        await maybeInstallDaemon({ runtime, port: gatewayPort });
      }

      if (selected.includes("health")) {
        await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
      }
    } else {
      let ranSection = false;
      let didConfigureGateway = false;

      while (true) {
        const choice = await promptConfigureSection(runtime, ranSection);
        if (choice === "__continue") {
          break;
        }
        ranSection = true;

        if (choice === "workspace") {
          await configureWorkspace();
          await persistConfig();
        }

        if (choice === "model") {
          nextConfig = await promptAuthConfig(nextConfig, runtime, prompter);
          await persistConfig();
        }

        if (choice === "web") {
          nextConfig = await promptWebToolsConfig(nextConfig, runtime);
          await persistConfig();
        }

        if (choice === "memory") {
          nextConfig = await promptCortexMemoryConfig(nextConfig, runtime, workspaceDir);
          await persistConfig();
        }

        if (choice === "gateway") {
          const gateway = await promptGatewayConfig(nextConfig, runtime);
          nextConfig = gateway.config;
          gatewayPort = gateway.port;
          didConfigureGateway = true;
          await persistConfig();
        }

        if (choice === "channels") {
          await configureChannelsSection();
          await persistConfig();
        }

        if (choice === "skills") {
          const wsDir = resolveUserPath(workspaceDir);
          nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
          await persistConfig();
        }

        if (choice === "daemon") {
          if (!didConfigureGateway) {
            await promptDaemonPort();
          }
          await maybeInstallDaemon({
            runtime,
            port: gatewayPort,
          });
        }

        if (choice === "health") {
          await runGatewayHealthCheck({ cfg: nextConfig, runtime, port: gatewayPort });
        }
      }

      if (!ranSection) {
        if (didSetGatewayMode) {
          await persistConfig();
          outro("Gateway mode set to local.");
          return;
        }
        outro("No changes selected.");
        return;
      }
    }

    const controlUiAssets = await ensureControlUiAssetsBuilt(runtime);
    if (!controlUiAssets.ok && controlUiAssets.message) {
      runtime.error(controlUiAssets.message);
    }

    const bind = nextConfig.gateway?.bind ?? "loopback";
    const links = resolveControlUiLinks({
      bind,
      port: gatewayPort,
      customBindHost: nextConfig.gateway?.customBindHost,
      basePath: nextConfig.gateway?.controlUi?.basePath,
    });
    // Try both new and old passwords since gateway may still have old config.
    const newPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const oldPassword =
      process.env.OPENCLAW_GATEWAY_PASSWORD ??
      process.env.CLAWDBOT_GATEWAY_PASSWORD ??
      (await resolveGatewaySecretInputForWizard({
        cfg: baseConfig,
        value: baseConfig.gateway?.auth?.password,
        path: "gateway.auth.password",
      }));
    const token =
      process.env.OPENCLAW_GATEWAY_TOKEN ??
      process.env.CLAWDBOT_GATEWAY_TOKEN ??
      (await resolveGatewaySecretInputForWizard({
        cfg: nextConfig,
        value: nextConfig.gateway?.auth?.token,
        path: "gateway.auth.token",
      }));

    let gatewayProbe = await probeGatewayReachable({
      url: links.wsUrl,
      token,
      password: newPassword,
    });
    // If new password failed and it's different from old password, try old too.
    if (!gatewayProbe.ok && newPassword !== oldPassword && oldPassword) {
      gatewayProbe = await probeGatewayReachable({
        url: links.wsUrl,
        token,
        password: oldPassword,
      });
    }
    const gatewayStatusLine = gatewayProbe.ok
      ? "Gateway: reachable"
      : `Gateway: not detected${gatewayProbe.detail ? ` (${gatewayProbe.detail})` : ""}`;

    note(
      [
        `Web UI: ${links.httpUrl}`,
        `Gateway WS: ${links.wsUrl}`,
        gatewayStatusLine,
        "Docs: https://docs.openclaw.ai/web/control-ui",
      ].join("\n"),
      "Control UI",
    );

    outro("Configure complete.");
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
