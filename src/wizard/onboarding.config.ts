import type { OpenClawConfig } from "../config/config.js";
import { resolveGatewayPort, writeConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { removeChannelConfigWizard } from "../commands/configure.channels.js";
import { promptAuthConfig } from "../commands/configure.gateway-auth.js";
import { promptGatewayConfig } from "../commands/configure.gateway.js";
import type { WizardSection } from "../commands/configure.shared.js";
import { CONFIGURE_SECTION_OPTIONS } from "../commands/configure.shared.js";
import { noteChannelStatus, setupChannels } from "../commands/onboard-channels.js";
import {
  DEFAULT_WORKSPACE,
  ensureWorkspaceAndSessions,
} from "../commands/onboard-helpers.js";
import { setupSkills } from "../commands/onboard-skills.js";
import type { WizardFlow } from "./onboarding.types.js";
import type { WizardPrompter } from "./prompts.js";

type ConfigureSectionChoice = WizardSection | "__continue";

// Web tools configuration function for onboarding
async function promptWebToolsConfig(
  nextConfig: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const existingSearch = nextConfig.tools?.web?.search;
  const existingFetch = nextConfig.tools?.web?.fetch;
  const hasSearchKey = Boolean(existingSearch?.apiKey);

  await prompter.note(
    [
      "Web search lets your agent look things up online using the `web_search` tool.",
      "It requires a Brave Search API key (you can store it in the config or set BRAVE_API_KEY in the Gateway environment).",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );

  const enableSearch = await prompter.confirm({
    message: "Enable web_search (Brave Search)?",
    initialValue: existingSearch?.enabled ?? hasSearchKey,
  });

  let nextSearch = {
    ...existingSearch,
    enabled: enableSearch,
  };

  if (enableSearch) {
    const keyInput = await prompter.text({
      message: hasSearchKey
        ? "Brave Search API key (leave blank to keep current or use BRAVE_API_KEY)"
        : "Brave Search API key (paste it here; leave blank to use BRAVE_API_KEY)",
      initialValue: "",
    });
    const key = String(keyInput ?? "").trim();
    if (key) {
      nextSearch = { ...nextSearch, apiKey: key };
    } else if (!hasSearchKey) {
      await prompter.note(
        [
          "No key stored yet, so web_search will stay unavailable.",
          "Store a key here or set BRAVE_API_KEY in the Gateway environment.",
          "Docs: https://docs.openclaw.ai/tools/web",
        ].join("\n"),
        "Web search",
      );
    }
  }

  const enableFetch = await prompter.confirm({
    message: "Enable web_fetch (keyless HTTP fetch)?",
    initialValue: existingFetch?.enabled ?? true,
  });

  const nextFetch = {
    ...existingFetch,
    enabled: enableFetch,
  };

  return {
    ...nextConfig,
    tools: {
      ...nextConfig.tools,
      web: {
        ...nextConfig.tools?.web,
        search: nextSearch,
        fetch: nextFetch,
      },
    },
  };
}

async function promptConfigureSection(
  prompter: WizardPrompter,
  hasSelection: boolean,
): Promise<ConfigureSectionChoice> {
  return await prompter.select<ConfigureSectionChoice>({
    message: "Select sections to configure",
    options: [
      ...CONFIGURE_SECTION_OPTIONS.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      {
        value: "__continue",
        label: "Continue",
        hint: hasSelection ? "Done" : "Skip for now",
      },
    ],
    initialValue: hasSelection ? "__continue" : undefined,
  });
}

export async function runOnboardingConfiguration(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  flow: WizardFlow;
}): Promise<OpenClawConfig> {
  const { config, workspaceDir, prompter, runtime, flow } = params;
  let nextConfig = { ...config };
  let currentWorkspaceDir = workspaceDir;
  let gatewayPort = resolveGatewayPort(nextConfig);
  let gatewayToken: string | undefined =
    nextConfig.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;

  const persistConfig = async () => {
    await writeConfigFile(nextConfig);
    logConfigUpdated(runtime);
  };

  const configureWorkspace = async () => {
    const workspaceInput = await prompter.text({
      message: "Workspace directory",
      initialValue: currentWorkspaceDir,
    });
    currentWorkspaceDir = resolveUserPath(String(workspaceInput ?? "").trim() || DEFAULT_WORKSPACE);
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          workspace: currentWorkspaceDir,
        },
      },
    };
    await ensureWorkspaceAndSessions(currentWorkspaceDir, runtime);
  };

  const configureChannelsSection = async () => {
    await noteChannelStatus({ cfg: nextConfig, prompter });
    const channelMode = await prompter.select({
      message: "Channel configuration mode",
      options: [
        { value: "configure", label: "Configure channels" },
        { value: "remove", label: "Remove channel configuration" },
      ],
    });
    if (channelMode === "configure") {
      nextConfig = await setupChannels(nextConfig, runtime, prompter, {
        allowDisable: true,
        allowSignalInstall: true,
        skipConfirm: flow === "quickstart",
        skipStatusNote: true,
      });
    } else {
      nextConfig = await removeChannelConfigWizard(nextConfig, runtime);
    }
  };

  let ranSection = false;

  while (true) {
    const choice = await promptConfigureSection(prompter, ranSection);
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
      nextConfig = await promptWebToolsConfig(nextConfig, prompter);
      await persistConfig();
    }

    if (choice === "gateway") {
      const gateway = await promptGatewayConfig(nextConfig, runtime);
      nextConfig = gateway.config;
      gatewayPort = gateway.port;
      gatewayToken = gateway.token;
      await persistConfig();
    }

    if (choice === "channels") {
      await configureChannelsSection();
      await persistConfig();
    }

    if (choice === "skills") {
      const wsDir = resolveUserPath(currentWorkspaceDir);
      nextConfig = await setupSkills(nextConfig, wsDir, runtime, prompter);
      await persistConfig();
    }

    if (choice === "daemon") {
      await prompter.note(
        "Daemon installation is handled during onboarding finalization.",
        "Daemon",
      );
    }

    if (choice === "health") {
      await prompter.note(
        "Health checks are run during onboarding verification.",
        "Health check",
      );
    }
  }

  if (ranSection) {
    await prompter.note("Configuration updated.", "Configuration");
  }

  return nextConfig;
}
