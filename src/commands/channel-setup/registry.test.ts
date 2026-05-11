import { describe, expect, it } from "vitest";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupWizard } from "../../channels/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "./registry.js";

function createSetupPlugin(params: {
  setupWizard: ChannelSetupPlugin["setupWizard"];
  id?: string;
}): ChannelSetupPlugin {
  return {
    ...createChannelTestPluginBase({
      id: params.id ?? "demo",
      label: params.id === "wecom" ? "WeCom" : "Demo",
    }),
    setup: {
      applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg,
    },
    setupWizard: params.setupWizard,
  };
}

describe("resolveChannelSetupWizardAdapterForPlugin", () => {
  it("builds and caches adapters from the plugin setupWizard surface", async () => {
    const setupWizard: ChannelSetupWizard = {
      channel: "demo",
      status: {
        configuredLabel: "Configured",
        unconfiguredLabel: "Not configured",
        resolveConfigured: () => false,
      },
      credentials: [],
    };
    const plugin = createSetupPlugin({ setupWizard });

    const adapter = resolveChannelSetupWizardAdapterForPlugin(plugin);

    expect(adapter?.channel).toBe("demo");
    const status = await adapter?.getStatus({
      cfg: {} as OpenClawConfig,
      accountOverrides: { demo: "default" },
    });
    expect(status?.channel).toBe("demo");
    expect(status?.configured).toBe(false);

    const configured = await adapter?.configure({
      cfg: {} as OpenClawConfig,
      runtime: {} as never,
      prompter: {} as never,
      options: {},
      accountOverrides: { demo: "default" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });
    expect(configured?.accountId).toBe("default");
    expect(configured?.cfg).toEqual({});
    expect(resolveChannelSetupWizardAdapterForPlugin(plugin)).toBe(adapter);
  });

  it("passes through adapter-shaped setupWizard surfaces", () => {
    const setupWizard = {
      channel: "demo",
      getStatus: async () => ({
        channel: "demo",
        configured: false,
        statusLines: [],
      }),
      configure: async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg }),
    };
    const plugin = createSetupPlugin({ setupWizard });

    expect(resolveChannelSetupWizardAdapterForPlugin(plugin)).toBe(setupWizard);
  });

  it("scopes WeCom declarative wizard callbacks to the selected account", async () => {
    const readDefaultAccount = (cfg: OpenClawConfig) => {
      const channel = cfg.channels?.wecom as
        | {
            defaultAccount?: string;
            botId?: string;
            secret?: string;
            accounts?: Record<string, { botId?: string; secret?: string; enabled?: boolean }>;
          }
        | undefined;
      const accountId = channel?.defaultAccount ?? "default";
      return {
        accountId,
        account: channel?.accounts?.[accountId] ?? channel ?? {},
      };
    };
    const writeDefaultAccount = (
      cfg: OpenClawConfig,
      patch: Record<string, unknown>,
    ): OpenClawConfig => {
      const channel = cfg.channels?.wecom as
        | { defaultAccount?: string; accounts?: Record<string, Record<string, unknown>> }
        | undefined;
      const accountId = channel?.defaultAccount ?? "default";
      const accounts = channel?.accounts;
      if (!accounts) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            wecom: {
              ...channel,
              ...patch,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          wecom: {
            ...channel,
            accounts: {
              ...accounts,
              [accountId]: {
                ...accounts[accountId],
                ...patch,
              },
            },
          },
        },
      } as OpenClawConfig;
    };
    const setupWizard: ChannelSetupWizard = {
      channel: "wecom",
      status: {
        configuredLabel: "Configured",
        unconfiguredLabel: "Not configured",
        resolveConfigured: ({ cfg }) => {
          const { account } = readDefaultAccount(cfg);
          return Boolean(account.botId && account.secret);
        },
      },
      credentials: [
        {
          inputKey: "token",
          providerHint: "WeCom",
          credentialLabel: "Bot ID",
          envPrompt: "Use env?",
          keepPrompt: "Keep Bot ID?",
          inputPrompt: "Bot ID",
          inspect: ({ cfg }) => {
            const { account } = readDefaultAccount(cfg);
            return {
              accountConfigured: Boolean(account.botId),
              hasConfiguredValue: Boolean(account.botId),
              resolvedValue: account.botId,
            };
          },
          applySet: ({ cfg, resolvedValue }) => writeDefaultAccount(cfg, { botId: resolvedValue }),
        },
        {
          inputKey: "privateKey",
          providerHint: "WeCom",
          credentialLabel: "Secret",
          envPrompt: "Use env?",
          keepPrompt: "Keep Secret?",
          inputPrompt: "Secret",
          inspect: ({ cfg }) => {
            const { account } = readDefaultAccount(cfg);
            return {
              accountConfigured: Boolean(account.secret),
              hasConfiguredValue: Boolean(account.secret),
              resolvedValue: account.secret,
            };
          },
          applySet: ({ cfg, resolvedValue }) => writeDefaultAccount(cfg, { secret: resolvedValue }),
        },
      ],
      finalize: ({ cfg }) => {
        const { account } = readDefaultAccount(cfg);
        return account.botId && account.secret
          ? { cfg: writeDefaultAccount(cfg, { enabled: true }) }
          : undefined;
      },
    };
    const plugin = createSetupPlugin({ id: "wecom", setupWizard });
    const adapter = resolveChannelSetupWizardAdapterForPlugin(plugin);
    const prompter = {
      text: async ({ message }: { message: string }) =>
        message === "Bot ID" ? "alerts-bot" : "alerts-secret",
      confirm: async () => false,
      select: async () => "unused",
      note: async () => undefined,
    };

    const configured = await adapter?.configure({
      cfg: {
        channels: {
          wecom: {
            enabled: true,
            botId: "main-bot",
            secret: "main-secret",
            accounts: {
              main: { name: "Main" },
            },
          },
        },
      } as OpenClawConfig,
      runtime: {} as never,
      prompter: prompter as never,
      options: { secretInputMode: "plaintext" },
      accountOverrides: { wecom: "alerts" },
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(configured?.cfg.channels?.wecom).toMatchObject({
      enabled: true,
      accounts: {
        main: { name: "Main", botId: "main-bot", secret: "main-secret" },
        alerts: { enabled: true, botId: "alerts-bot", secret: "alerts-secret" },
      },
    });
    expect(configured?.cfg.channels?.wecom).not.toHaveProperty("botId");
    expect(configured?.cfg.channels?.wecom).not.toHaveProperty("secret");
    expect(configured?.cfg.channels?.wecom).not.toHaveProperty("defaultAccount");
  });
});
