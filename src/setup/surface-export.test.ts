import { describe, expect, it, vi } from "vitest";
import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
import { exportSetupSurface } from "./surface-export.js";

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => undefined,
  resolveDefaultAgentId: () => "main",
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

vi.mock("../plugins/logger.js", () => ({
  createPluginLoaderLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

const loadOpenClawPlugins = vi.fn();
vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPlugins(...args),
}));

const listChannelPluginCatalogEntries = vi.fn();
vi.mock("../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: (...args: unknown[]) => listChannelPluginCatalogEntries(...args),
}));

const resolveChannelSetupWizardAdapterForPlugin = vi.fn();
vi.mock("../commands/channel-setup/registry.js", () => ({
  resolveChannelSetupWizardAdapterForPlugin: (...args: unknown[]) =>
    resolveChannelSetupWizardAdapterForPlugin(...args),
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured: () => false,
}));

describe("exportSetupSurface", () => {
  it("exports provider auth surface metadata and channel setup fields", async () => {
    const apiKeyMethod = createProviderApiKeyAuthMethod({
      providerId: "demo-provider",
      methodId: "api-key",
      label: "API Key",
      optionKey: "demoApiKey",
      flagName: "--demo-api-key",
      envVar: "DEMO_API_KEY",
      promptMessage: "Enter API key",
      wizard: {
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider",
        groupId: "demo",
        groupLabel: "Demo",
      },
    });

    const installedChannelPlugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram (Bot API)",
        detailLabel: "Telegram Bot",
        docsPath: "/channels/telegram",
        blurb: "Bot API setup",
        aliases: ["tg"],
      },
      config: {
        listAccountIds: () => ["default"],
      },
      setupWizard: {
        channel: "telegram",
        status: {
          configuredLabel: "configured",
          unconfiguredLabel: "not configured",
          resolveConfigured: () => false,
        },
        credentials: [
          {
            inputKey: "token",
            providerHint: "telegram",
            credentialLabel: "Bot token",
            preferredEnvVar: "TELEGRAM_BOT_TOKEN",
            envPrompt: "Use env?",
            keepPrompt: "Keep token?",
            inputPrompt: "Enter bot token",
            inspect: () => ({ accountConfigured: false, hasConfiguredValue: false }),
          },
        ],
        textInputs: [
          {
            inputKey: "allowFrom",
            message: "Allow from",
            placeholder: "@user",
          },
        ],
        envShortcut: {
          prompt: "Use TELEGRAM_BOT_TOKEN?",
          preferredEnvVar: "TELEGRAM_BOT_TOKEN",
          isAvailable: () => true,
          apply: ({ cfg }: { cfg: unknown }) => cfg,
        },
        allowFrom: {
          message: "Allow from",
          placeholder: "@user",
          invalidWithoutCredentialNote: "Need token",
          parseId: () => null,
          resolveEntries: async () => [],
          apply: async ({ cfg }: { cfg: unknown }) => cfg,
        },
        dmPolicy: {
          label: "Telegram",
          channel: "telegram",
          policyKey: "channels.telegram.dmPolicy",
          allowFromKey: "channels.telegram.allowFrom",
          getCurrent: () => "pairing",
          setPolicy: (cfg: unknown) => cfg as never,
        },
        stepOrder: "credentials-first",
      },
    };

    loadOpenClawPlugins.mockReturnValue({
      providers: [
        {
          pluginId: "demo-plugin",
          provider: {
            id: "demo-provider",
            label: "Demo Provider",
            docsPath: "/providers/demo",
            aliases: ["demo"],
            envVars: ["DEMO_API_KEY"],
            auth: [apiKeyMethod],
            wizard: {
              modelPicker: {
                label: "Demo models",
                hint: "Pick one",
              },
            },
          },
        },
      ],
      channelSetups: [
        {
          pluginId: "telegram",
          plugin: installedChannelPlugin,
          enabled: true,
        },
      ],
    });

    resolveChannelSetupWizardAdapterForPlugin.mockReturnValue({
      getStatus: async () => ({
        channel: "telegram",
        configured: false,
        statusLines: ["Telegram: needs token"],
        selectionHint: "needs token",
        quickstartScore: 10,
      }),
    });

    listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "slack",
        pluginId: "slack",
        meta: {
          label: "Slack",
          selectionLabel: "Slack (Socket Mode)",
          docsPath: "/channels/slack",
          blurb: "Slack setup",
        },
        install: {
          npmSpec: "@openclaw/slack",
        },
      },
    ]);

    const surface = await exportSetupSurface({
      config: {} as never,
    });

    expect(surface.version).toBe(1);
    expect(surface.providers).toHaveLength(1);
    expect(surface.providers[0]).toMatchObject({
      id: "demo-provider",
      pluginId: "demo-plugin",
      envVars: ["DEMO_API_KEY"],
      methods: [
        {
          id: "api-key",
          label: "API Key",
          choiceId: "demo-provider-api-key",
          groupId: "demo",
          surface: {
            kind: "api_key",
            optionKey: "demoApiKey",
            flagName: "--demo-api-key",
            envVar: "DEMO_API_KEY",
          },
        },
      ],
    });

    expect(surface.channels).toHaveLength(2);
    expect(surface.channels[0]).toMatchObject({
      id: "telegram",
      installed: true,
      installable: false,
      status: {
        configured: false,
        lines: ["Telegram: needs token"],
        selectionHint: "needs token",
        quickstartScore: 10,
      },
      features: {
        envShortcut: true,
        allowFrom: true,
        dmPolicy: true,
      },
      fields: [
        {
          kind: "secret",
          key: "token",
          label: "Bot token",
          preferredEnvVar: "TELEGRAM_BOT_TOKEN",
        },
        {
          kind: "text",
          key: "allowFrom",
          label: "Allow from",
          placeholder: "@user",
        },
      ],
    });
    expect(surface.channels[1]).toMatchObject({
      id: "slack",
      installed: false,
      installable: true,
      status: {
        configured: false,
        selectionHint: "plugin · install",
      },
    });
  });
});
