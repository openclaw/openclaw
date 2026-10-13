// Onboard channels e2e tests cover setup wizard adapters, plugin install hooks, and channel picker behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExitThrowingRuntime, createWizardPrompter } from "../../test/helpers/auth-wizard.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelSetupWizardAdapter } from "../channels/plugins/setup-wizard-types.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "../commands/channel-setup/plugin-install.js";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn(),
}));

const manifestRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistryCore: vi.fn(() => ({ plugins: [], diagnostics: [] })),
}));

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(
    {
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      ...overrides,
    },
    { defaultSelect: "__done__" },
  );
}

function createUnexpectedPromptGuards() {
  return {
    multiselect: vi.fn(async () => {
      throw new Error("unexpected multiselect");
    }),
    text: vi.fn(async ({ message }: { message: string }) => {
      throw new Error(`unexpected text prompt: ${message}`);
    }) as unknown as WizardPrompter["text"],
  };
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function hasCallWithFields(mock: MockWithCalls, expected: Record<string, unknown>): boolean {
  return mock.mock.calls.some(([value]) => {
    if (
      value === undefined ||
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return false;
    }
    const arg = value as Record<string, unknown>;
    return Object.entries(expected).every(([key, expectedValue]) => arg[key] === expectedValue);
  });
}

function expectCalledWithFields(mock: MockWithCalls, expected: Record<string, unknown>): void {
  expect(hasCallWithFields(mock, expected)).toBe(true);
}

type SetupChannels = typeof import("../flows/channel-setup.js").setupChannels;
let setupChannels: SetupChannels;

type SetupChannelsOptions = Parameters<SetupChannels>[3];

function runSetupChannels(
  cfg: OpenClawConfig,
  prompter: WizardPrompter,
  options?: SetupChannelsOptions,
) {
  return setupChannels(cfg, createExitThrowingRuntime(), prompter, {
    skipConfirm: true,
    ...options,
  });
}

function createMSTeamsCatalogEntry(): ChannelPluginCatalogEntry {
  return {
    id: "external-chat",
    pluginId: "@openclaw/external-chat-plugin",
    meta: {
      id: "external-chat",
      label: "External Chat",
      selectionLabel: "External Chat",
      docsPath: "/channels/external-chat",
      blurb: "external chat channel",
    },
    install: {
      npmSpec: "@openclaw/external-chat",
    },
  };
}

function setMinimalOnboardingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "telegram",
            label: "Telegram",
            capabilities: { chatTypes: ["direct", "group"] },
          }),
          setup: {
            applyAccountConfig: ({
              cfg,
              input,
            }: {
              cfg: OpenClawConfig;
              input: { token?: string };
            }) =>
              ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  telegram: {
                    ...(cfg.channels?.telegram as Record<string, unknown> | undefined),
                    ...(input.token ? { botToken: input.token } : {}),
                  },
                },
              }) as OpenClawConfig,
          },
          setupWizard: {
            channel: "telegram",
            status: {
              configuredLabel: "configured",
              unconfiguredLabel: "not configured",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean(cfg.channels?.telegram?.botToken),
            },
            credentials: [
              {
                inputKey: "token",
                providerHint: "BotFather",
                credentialLabel: "Telegram bot token",
                envPrompt: "Use TELEGRAM_BOT_TOKEN from env?",
                keepPrompt: "Keep current Telegram bot token?",
                inputPrompt: "Enter Telegram bot token",
                inspect: ({ cfg }: { cfg: OpenClawConfig }) => ({
                  accountConfigured: Boolean(cfg.channels?.telegram?.botToken),
                  hasConfiguredValue: Boolean(cfg.channels?.telegram?.botToken),
                }),
              },
            ],
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "whatsapp",
            label: "WhatsApp",
            capabilities: { chatTypes: ["direct", "group"] },
          }),
          setup: {
            applyAccountConfig: ({
              cfg,
              input,
            }: {
              cfg: OpenClawConfig;
              input: { account?: string; name?: string };
            }) =>
              ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  whatsapp: {
                    ...(cfg.channels?.whatsapp as Record<string, unknown> | undefined),
                    ...(input.account ? { account: input.account } : {}),
                    ...(input.name ? { name: input.name } : {}),
                    linked: false,
                  },
                },
              }) as OpenClawConfig,
          },
          setupWizard: {
            channel: "whatsapp",
            status: {
              configuredLabel: "configured",
              unconfiguredLabel: "not linked",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean((cfg.channels?.whatsapp as { account?: string } | undefined)?.account),
              resolveSelectionHint: async ({ cfg }: { cfg: OpenClawConfig }) =>
                (cfg.channels?.whatsapp as { account?: string } | undefined)?.account
                  ? "configured"
                  : "not linked",
            },
            credentials: [],
            textInputs: [
              {
                inputKey: "account",
                message: "Your personal WhatsApp number",
                required: true,
                applySet: ({ cfg, value }: { cfg: OpenClawConfig; value: string }) =>
                  ({
                    ...cfg,
                    channels: {
                      ...cfg.channels,
                      whatsapp: {
                        ...(cfg.channels?.whatsapp as Record<string, unknown> | undefined),
                        account: value,
                      },
                    },
                  }) as OpenClawConfig,
              },
            ],
          },
        },
      },
    ]),
  );
}

function createMSTeamsPluginRegistryEntry(params?: { includeSetupWizard?: boolean }) {
  return {
    pluginId: "@openclaw/external-chat-plugin",
    source: "test",
    plugin: {
      id: "external-chat",
      meta: createMSTeamsCatalogEntry().meta,
      capabilities: { chatTypes: ["direct"] as const },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({ accountId: "default" }),
      },
      ...(params?.includeSetupWizard
        ? {
            setupWizard: {
              channel: "external-chat",
              status: {
                configuredLabel: "configured",
                unconfiguredLabel: "installed",
                resolveConfigured: () => false,
                resolveStatusLines: async () => [],
                resolveSelectionHint: async () => "installed",
              },
              credentials: [],
            },
          }
        : {}),
      outbound: { deliveryMode: "direct" as const },
    },
  };
}

function mockMSTeamsRegistrySnapshot(params?: { includeSetupWizard?: boolean }) {
  vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockImplementation(
    ({ channel }: { channel: string }) => {
      const registry = createEmptyPluginRegistry();
      if (channel === "external-chat") {
        if (params?.includeSetupWizard) {
          registry.channelSetups.push(createMSTeamsPluginRegistryEntry(params) as never);
        } else {
          registry.channels.push(createMSTeamsPluginRegistryEntry(params) as never);
        }
      }
      return registry;
    },
  );
}

vi.mock("../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/catalog.js")>(
    "../channels/plugins/catalog.js",
  );
  const listRawChannelPluginCatalogEntries = (
    ...args: Parameters<typeof actual.listRawChannelPluginCatalogEntries>
  ) => {
    const implementation = catalogMocks.listChannelPluginCatalogEntries.getMockImplementation();
    if (implementation) {
      return catalogMocks.listChannelPluginCatalogEntries(...args);
    }
    return actual.listRawChannelPluginCatalogEntries(...args);
  };
  return {
    ...actual,
    listRawChannelPluginCatalogEntries,
  };
});

vi.mock("../plugins/manifest-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/manifest-registry.js")>(
    "../plugins/manifest-registry.js",
  );
  return {
    ...actual,
    loadPluginManifestRegistryCore: manifestRegistryMocks.loadPluginManifestRegistryCore,
  };
});

vi.mock("../channels/plugins/bundled.js", () => ({
  getBundledChannelSetupPlugin: (channel: string) =>
    channel === "telegram"
      ? {
          id: "telegram",
          meta: {
            id: "telegram",
            label: "Telegram",
            selectionLabel: "Telegram",
            docsPath: "/channels/telegram",
            blurb: "test stub.",
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
          setup: {
            applyAccountConfig: ({
              cfg,
              input,
            }: {
              cfg: OpenClawConfig;
              input: { token?: string };
            }) =>
              ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  telegram: {
                    ...(cfg.channels?.telegram as Record<string, unknown> | undefined),
                    ...(input.token ? { botToken: input.token } : {}),
                  },
                },
              }) as OpenClawConfig,
          },
          setupWizard: {
            channel: "telegram",
            status: {
              configuredLabel: "configured",
              unconfiguredLabel: "not configured",
              resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
                Boolean(cfg.channels?.telegram?.botToken),
            },
            credentials: [
              {
                inputKey: "token",
                providerHint: "BotFather",
                credentialLabel: "Telegram bot token",
                envPrompt: "Use TELEGRAM_BOT_TOKEN from env?",
                keepPrompt: "Keep current Telegram bot token?",
                inputPrompt: "Enter Telegram bot token",
                inspect: ({ cfg }: { cfg: OpenClawConfig }) => ({
                  accountConfigured: Boolean(cfg.channels?.telegram?.botToken),
                  hasConfiguredValue: Boolean(cfg.channels?.telegram?.botToken),
                }),
              },
            ],
          },
        }
      : undefined,
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBinary: vi.fn(async () => false),
}));

vi.mock("../commands/channel-setup/plugin-install.js", async () => {
  const actual = await vi.importActual("../commands/channel-setup/plugin-install.js");
  return {
    ...(actual as Record<string, unknown>),
    ensureChannelSetupPluginInstalled: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg,
      installed: true,
    })),
    // Allow tests to simulate an empty plugin registry during setup.
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(() => createEmptyPluginRegistry()),
  };
});

describe("setupChannels", () => {
  beforeEach(async () => {
    ({ setupChannels } = await import("../flows/channel-setup.js"));
    setMinimalOnboardingRegistryForTests();
    catalogMocks.listChannelPluginCatalogEntries.mockReset();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    manifestRegistryMocks.loadPluginManifestRegistryCore.mockReset();
    manifestRegistryMocks.loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
  });

  it.each([
    {
      name: "explicitly confirmed",
      configureOwner: true,
      confirmOwner: true,
      owners: undefined,
      expected: ["discord:123456789012345678"],
    },
    {
      name: "skipped",
      configureOwner: false,
      confirmOwner: false,
      owners: undefined,
      expected: undefined,
    },
    {
      name: "declined at confirmation",
      configureOwner: true,
      confirmOwner: false,
      owners: undefined,
      expected: undefined,
    },
    {
      name: "already configured",
      configureOwner: true,
      confirmOwner: true,
      owners: ["telegram:existing-owner"],
      expected: ["telegram:existing-owner"],
    },
  ])(
    "keeps Discord guild-only owner setup $name",
    async ({ configureOwner, confirmOwner, owners, expected }) => {
      const channels: OpenClawConfig["channels"] = {
        discord: {
          enabled: true,
          dm: { enabled: false },
          allowFrom: ["987654321098765432"],
          guilds: { "234567890123456789": { users: ["987654321098765432"] } },
        },
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "discord",
                label: "Discord",
                capabilities: { chatTypes: ["direct", "group"] },
              }),
              setupWizard: {
                channel: "discord",
                getStatus: async () => ({ channel: "discord", configured: true, statusLines: [] }),
                configure: async ({ cfg }: { cfg: OpenClawConfig }) => ({
                  cfg,
                  accountId: "default",
                }),
                configureInteractive: async ({ cfg }: { cfg: OpenClawConfig }) => ({
                  cfg,
                  accountId: "default",
                }),
              },
            },
          },
        ]),
      );
      const prompter = createPrompter({
        select: vi.fn(async ({ message, options }: Parameters<WizardPrompter["select"]>[0]) => {
          if (message === "Set up administration from your own chat account?") {
            const label = configureOwner ? "Set up my operator account" : "Skip for now";
            const option = options.find((entry) => entry.label === label);
            if (!option) {
              throw new Error(`missing owner setup choice: ${label}`);
            }
            return option.value;
          }
          throw new Error(`unexpected selection: ${message}`);
        }) as WizardPrompter["select"],
        text: vi.fn(async () => "123456789012345678"),
        confirm: vi.fn(async () => confirmOwner),
      });
      const next = await runSetupChannels(
        { channels, commands: { restart: false, ownerAllowFrom: owners } },
        prompter,
        {
          initialSelection: ["discord"],
          finishAfterInitialSelection: true,
          skipDmPolicyPrompt: true,
        },
      );

      expect(next.commands?.ownerAllowFrom).toEqual(expected);
      expect(next.commands?.restart).toBe(false);
      expect(next.channels).toEqual(channels);
      if (!owners) {
        const setupPrompt = vi
          .mocked(prompter.select)
          .mock.calls.find(
            ([prompt]) => prompt.message === "Set up administration from your own chat account?",
          )?.[0];
        expect(
          setupPrompt?.options.find((option) => option.value === setupPrompt.initialValue)?.label,
        ).toBe("Skip for now");
      }
      if (owners || !configureOwner) {
        expect(prompter.text).not.toHaveBeenCalled();
        expect(prompter.confirm).not.toHaveBeenCalled();
      } else {
        expect(prompter.text).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Your personal Discord user ID (not a bot, server, or channel ID)",
          }),
        );
        expect(vi.mocked(prompter.text).mock.calls[0]?.[0].initialValue).toBeUndefined();
        expect(prompter.confirm).toHaveBeenCalledWith({
          message:
            "This is my account: allow discord:123456789012345678 to administer this installation?",
          initialValue: false,
        });
      }
    },
  );

  it.each(["incomplete", "removed", "disabled", "account-disabled", "unverifiable"] as const)(
    "offers owner setup only for final configured channels: %s",
    async (outcome) => {
      let setupReturned = false;
      const setupWizard: ChannelSetupWizardAdapter = {
        channel: "discord",
        getStatus: async ({ cfg }) => {
          if (setupReturned && outcome === "unverifiable") {
            throw new Error("controlled status failure");
          }
          return {
            channel: "discord",
            configured: Boolean(cfg.channels?.discord?.token),
            statusLines: [],
          };
        },
        configure: async ({ cfg }) => {
          setupReturned = true;
          return {
            cfg: {
              ...cfg,
              channels: {
                ...cfg.channels,
                discord: {
                  ...cfg.channels?.discord,
                  ...(outcome === "incomplete" ? {} : { token: "synthetic-token" }),
                  ...(outcome === "account-disabled"
                    ? { accounts: { secondary: { enabled: false } } }
                    : {}),
                },
              },
            },
            accountId: outcome === "account-disabled" ? "secondary" : "default",
          };
        },
      };
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "discord",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: "discord",
                label: "Discord",
                config: {
                  resolveAccount: (cfg, accountId) =>
                    cfg.channels?.discord?.accounts?.[accountId ?? "default"] ??
                    cfg.channels?.discord ??
                    {},
                  deleteAccount: ({ cfg }) => {
                    const channels = { ...cfg.channels };
                    delete channels.discord;
                    return { ...cfg, channels };
                  },
                  setAccountEnabled: ({ cfg, enabled }) => ({
                    ...cfg,
                    channels: {
                      ...cfg.channels,
                      discord: { ...cfg.channels?.discord, enabled },
                    },
                  }),
                },
              }),
              setupWizard,
            },
          },
        ]),
      );
      const choices = [
        "discord",
        ...(outcome === "removed" || outcome === "disabled" ? ["discord"] : []),
        "__done__",
      ];
      const prompter = createPrompter({
        select: vi.fn(async ({ message, options }: Parameters<WizardPrompter["select"]>[0]) => {
          if (message === "Select a channel") {
            return choices.shift();
          }
          if (message === "Discord already configured. What do you want to do?") {
            return outcome === "removed" ? "delete" : "disable";
          }
          if (message === "Set up administration from your own chat account?") {
            return options.find((option) => option.label === "Set up my operator account")?.value;
          }
          throw new Error(`unexpected selection: ${message}`);
        }) as WizardPrompter["select"],
        text: vi.fn(async () => "123456789012345678"),
        confirm: vi.fn(async () => true),
      });
      const next = await runSetupChannels(
        { channels: { discord: { enabled: true, allowFrom: ["987654321098765432"] } } },
        prompter,
        { allowDisable: true, skipDmPolicyPrompt: true },
      );

      expect(next.commands?.ownerAllowFrom).toBeUndefined();
      expect(next.channels?.discord?.token).toBe(
        ["incomplete", "removed"].includes(outcome) ? undefined : "synthetic-token",
      );
      expect(prompter.text).not.toHaveBeenCalled();
      if (outcome === "unverifiable") {
        expect(prompter.note).toHaveBeenCalledWith(
          expect.stringContaining("controlled status failure"),
          "Channel status",
        );
      }
    },
  );

  it("keeps configured external plugin channels visible when the active registry starts empty", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([createMSTeamsCatalogEntry()]);
    mockMSTeamsRegistrySnapshot();
    const select = vi.fn(async ({ message, options }: { message: string; options: unknown[] }) => {
      if (message === "Select a channel") {
        const entries = options as Array<{ value: string; hint?: string }>;
        const msteams = entries.find((entry) => entry.value === "external-chat");
        if (msteams === undefined) {
          throw new Error("expected Teams catalog entry");
        }
        expect(msteams.hint ?? "").not.toContain("plugin");
        expect(msteams.hint ?? "").not.toContain("install");
        return "__done__";
      }
      return "__done__";
    });
    const { multiselect, text } = createUnexpectedPromptGuards();
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels(
      {
        channels: {
          "external-chat": {
            tenantId: "tenant-1",
          },
        },
        plugins: {
          entries: {
            "@openclaw/external-chat-plugin": { enabled: true },
          },
        },
      } as OpenClawConfig,
      prompter,
    );

    expectCalledWithFields(vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel), {
      channel: "external-chat",
      pluginId: "@openclaw/external-chat-plugin",
    });
    expect(multiselect).not.toHaveBeenCalled();
  });

  it("treats installed external plugin channels as installed without reinstall prompts", async () => {
    setActivePluginRegistry(
      createTestRegistry([createMSTeamsPluginRegistryEntry({ includeSetupWizard: true }) as never]),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([createMSTeamsCatalogEntry()]);

    let channelSelectionCount = 0;
    const select = vi.fn(async ({ message }: { message: string }) => {
      if (message === "Select a channel") {
        channelSelectionCount += 1;
        return channelSelectionCount === 1 ? "external-chat" : "__done__";
      }
      return "__done__";
    });
    const { multiselect, text } = createUnexpectedPromptGuards();
    const prompter = createPrompter({
      select: select as unknown as WizardPrompter["select"],
      multiselect,
      text,
    });

    await runSetupChannels({} as OpenClawConfig, prompter);

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(multiselect).not.toHaveBeenCalled();
  });
});
