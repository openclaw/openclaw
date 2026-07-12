// Tests allowlist command edits across legacy and scoped channel configuration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { formatAllowFromLowercase } from "../../plugin-sdk/allow-from.js";
import {
  buildDmGroupAccountAllowlistAdapter,
  buildLegacyDmAccountAllowlistAdapter,
} from "../../plugin-sdk/allowlist-config-edit.js";
import { createScopedChannelConfigAdapter } from "../../plugin-sdk/channel-config-helpers.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import type { HandleCommandsParams } from "./commands-types.js";
import type { ConfigSnapshotMock } from "./commands.test-harness.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());
const addChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
const removeChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  replaceConfigFile: replaceConfigFileMock,
  transformConfigFileWithRetry: async (params: {
    afterWrite?: unknown;
    transform: (
      currentConfig: OpenClawConfig,
      context: { snapshot: ConfigSnapshotMock; previousHash: string | null; attempt: number },
    ) =>
      | Promise<{ nextConfig: OpenClawConfig; result?: unknown }>
      | {
          nextConfig: OpenClawConfig;
          result?: unknown;
        };
  }) => {
    const snapshot = (await readConfigFileSnapshotMock()) as ConfigSnapshotMock;
    const previousHash = snapshot.hash ?? null;
    const currentConfig = structuredClone(
      snapshot.sourceConfig ?? snapshot.resolved ?? snapshot.runtimeConfig ?? snapshot.parsed ?? {},
    );
    const transformed = await params.transform(currentConfig, {
      snapshot,
      previousHash,
      attempt: 0,
    });
    const afterWrite = params.afterWrite ?? { mode: "auto" };
    const writePayload = { nextConfig: transformed.nextConfig, afterWrite };
    await replaceConfigFileMock(writePayload);
    return {
      path: snapshot.path ?? "/tmp/openclaw.json",
      previousHash,
      persistedHash: "persisted-hash",
      snapshot,
      nextConfig: transformed.nextConfig,
      result: transformed.result,
      attempts: 1,
      afterWrite,
      followUp: { action: "none" },
    };
  },
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
  addChannelAllowFromStoreEntry: addChannelAllowFromStoreEntryMock,
  removeChannelAllowFromStoreEntry: removeChannelAllowFromStoreEntryMock,
}));

// The cross-channel owner guard reuses resolveCommandAuthorization to re-derive
// owner status for the target channel. Its own correctness is covered by
// command-auth tests; here we substitute a minimal cfg-driven owner check so the
// guard's enforcement (block/allow) is exercised deterministically.
vi.mock("../command-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../command-auth.js")>();
  return {
    ...actual,
    resolveCommandAuthorization: vi.fn(
      (params: { ctx: { Provider?: string; SenderId?: string }; cfg: OpenClawConfig }) => {
        const target = params.ctx.Provider ?? "";
        const sender = String(params.ctx.SenderId ?? "");
        const channelAllow = (
          (params.cfg.channels as Record<string, { allowFrom?: unknown[] }> | undefined)?.[target]
            ?.allowFrom ?? []
        ).map(String);
        const globalOwners = (params.cfg.commands?.ownerAllowFrom ?? []).map((owner) =>
          String(owner).includes(":") ? String(owner).split(":").pop() : String(owner),
        );
        const senderIsOwner =
          channelAllow.includes("*") ||
          channelAllow.includes(sender) ||
          globalOwners.includes(sender);
        return { senderIsOwner } as ReturnType<typeof actual.resolveCommandAuthorization>;
      },
    ),
  };
});

type TelegramTestSectionConfig = {
  allowFrom?: string[];
  groupAllowFrom?: string[];
  defaultAccount?: string;
  configWrites?: boolean;
  accounts?: Record<string, TelegramTestSectionConfig>;
};

type DmGroupAllowlistTestSectionConfig = {
  allowFrom?: string[];
  groupAllowFrom?: string[];
  dm?: {
    allowFrom?: string[];
  };
};

function normalizeTelegramAllowFromEntries(values: Array<string | number>): string[] {
  return formatAllowFromLowercase({ allowFrom: values, stripPrefixRe: /^(telegram|tg):/i });
}

function normalizeAllowlistValues(values: Array<string | number>): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const entry = String(value).trim();
    if (entry) {
      normalized.push(entry);
    }
  }
  return normalized;
}

function resolveTelegramTestAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): TelegramTestSectionConfig {
  const section = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
    return section ?? {};
  }
  return {
    ...section,
    ...section?.accounts?.[accountId],
  };
}

const telegramAllowlistTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "telegram",
    label: "Telegram",
    docsPath: "/channels/telegram",
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      nativeCommands: true,
    },
  }),
  config: createScopedChannelConfigAdapter({
    sectionKey: "telegram",
    listAccountIds: (cfg) => {
      const channel = cfg.channels?.telegram as TelegramTestSectionConfig | undefined;
      return channel?.accounts ? Object.keys(channel.accounts) : [DEFAULT_ACCOUNT_ID];
    },
    resolveAccount: (cfg, accountId) => resolveTelegramTestAccount(cfg, accountId),
    defaultAccountId: (cfg) =>
      (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
      DEFAULT_ACCOUNT_ID,
    clearBaseFields: [],
    resolveAllowFrom: (account) => account.allowFrom,
    formatAllowFrom: normalizeTelegramAllowFromEntries,
  }),
  pairing: {
    idLabel: "telegramUserId",
  },
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: "telegram",
    resolveAccount: ({ cfg, accountId }) => resolveTelegramTestAccount(cfg, accountId),
    normalize: ({ values }) => normalizeTelegramAllowFromEntries(values),
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveDmPolicy: () => undefined,
    resolveGroupPolicy: () => undefined,
  }),
};

const whatsappAllowlistTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "whatsapp",
    label: "WhatsApp",
    docsPath: "/channels/whatsapp",
    capabilities: {
      chatTypes: ["direct", "group"],
      nativeCommands: true,
    },
  }),
  pairing: {
    idLabel: "phone",
  },
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: "whatsapp",
    resolveAccount: ({ cfg }) =>
      (cfg.channels?.whatsapp as DmGroupAllowlistTestSectionConfig | undefined) ?? {},
    normalize: ({ values }) => normalizeAllowlistValues(values),
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveDmPolicy: () => undefined,
    resolveGroupPolicy: () => undefined,
  }),
};

function createLegacyAllowlistPlugin(channelId: "discord" | "slack"): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: channelId,
      label: channelId === "discord" ? "Discord" : "Slack",
      docsPath: `/channels/${channelId}`,
      capabilities: {
        chatTypes: ["direct", "group", "thread"],
        nativeCommands: true,
      },
    }),
    pairing: {
      idLabel: channelId === "discord" ? "discordUserId" : "slackUserId",
    },
    allowlist: buildLegacyDmAccountAllowlistAdapter({
      channelId,
      resolveAccount: ({ cfg }) =>
        (cfg.channels?.[channelId] as DmGroupAllowlistTestSectionConfig | undefined) ?? {},
      normalize: ({ values }) => normalizeAllowlistValues(values),
      resolveDmAllowFrom: (account) => account.allowFrom ?? account.dm?.allowFrom,
      resolveGroupPolicy: () => undefined,
      resolveGroupOverrides: () => undefined,
    }),
  };
}

function setAllowlistPluginRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: telegramAllowlistTestPlugin, source: "test" },
      { pluginId: "whatsapp", plugin: whatsappAllowlistTestPlugin, source: "test" },
      { pluginId: "discord", plugin: createLegacyAllowlistPlugin("discord"), source: "test" },
      { pluginId: "slack", plugin: createLegacyAllowlistPlugin("slack"), source: "test" },
    ]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setAllowlistPluginRegistry();
  readConfigFileSnapshotMock.mockImplementation(async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      return { valid: false, parsed: null };
    }
    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    return { valid: true, parsed };
  });
  validateConfigObjectWithPluginsMock.mockImplementation((config: unknown) => ({
    ok: true,
    config,
  }));
  replaceConfigFileMock.mockImplementation(async (params: { nextConfig: unknown }) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (configPath) {
      await fs.writeFile(configPath, JSON.stringify(params.nextConfig, null, 2), "utf-8");
    }
  });
  readChannelAllowFromStoreMock.mockResolvedValue([]);
  addChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
  removeChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
});

async function withTempConfigPath<T>(
  initialConfig: Record<string, unknown>,
  run: (configPath: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-allowlist-config-"));
  const configPath = path.join(dir, "openclaw.json");
  const previous = process.env.OPENCLAW_CONFIG_PATH;
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
  await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf-8");
  try {
    return await run(configPath);
  } finally {
    if (previous === undefined) {
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    } else {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", previous);
    }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

function buildAllowlistParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: {
    Provider?: string;
    Surface?: string;
    AccountId?: string;
    SenderId?: string;
    From?: string;
    GatewayClientScopes?: string[];
  },
): HandleCommandsParams {
  const provider = ctxOverrides?.Provider ?? "telegram";
  return {
    cfg,
    ctx: {
      Provider: provider,
      Surface: ctxOverrides?.Surface ?? provider,
      CommandSource: "text",
      AccountId: ctxOverrides?.AccountId,
      GatewayClientScopes: ctxOverrides?.GatewayClientScopes,
      SenderId: ctxOverrides?.SenderId,
      From: ctxOverrides?.From,
    },
    command: {
      commandBodyNormalized: commandBody,
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: ctxOverrides?.SenderId ?? "owner",
      channel: provider,
      channelId: provider,
    },
  } as unknown as HandleCommandsParams;
}

describe("handleAllowlistCommand", () => {
  it("lists config and store allowFrom entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValueOnce(["456"]);

    const cfg = {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["123", "@Alice"] } },
    } as OpenClawConfig;
    const result = await handleAllowlistCommand(
      buildAllowlistParams("/allowlist list dm", cfg),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: telegram");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123, @alice");
    expect(result?.reply?.text).toContain("Paired allowFrom (store): 456");
  });

  it("adds allowlist entries to config and pairing stores", async () => {
    const cases = [
      {
        name: "default account",
        run: async () => {
          await withTempConfigPath(
            {
              channels: { telegram: { allowFrom: ["123"] } },
            },
            async (configPath) => {
              readConfigFileSnapshotMock.mockResolvedValueOnce({
                valid: true,
                parsed: {
                  channels: { telegram: { allowFrom: ["123"] } },
                },
              });
              addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
                changed: true,
                allowFrom: ["123", "789"],
              });

              const params = buildAllowlistParams("/allowlist add dm 789", {
                commands: { text: true, config: true },
                channels: { telegram: { allowFrom: ["123"] } },
              } as OpenClawConfig);
              params.command.senderIsOwner = true;
              const result = await handleAllowlistCommand(params, true);

              expect(result?.shouldContinue, "default account").toBe(false);
              const written = await readJsonFile<OpenClawConfig>(configPath);
              expect(written.channels?.telegram?.allowFrom, "default account").toEqual([
                "123",
                "789",
              ]);
              expect(addChannelAllowFromStoreEntryMock, "default account").toHaveBeenCalledWith({
                channel: "telegram",
                entry: "789",
                accountId: "default",
              });
              expect(result?.reply?.text, "default account").toContain("DM allowlist added");
            },
          );
        },
      },
      {
        name: "selected account scope",
        run: async () => {
          readConfigFileSnapshotMock.mockResolvedValueOnce({
            valid: true,
            parsed: {
              channels: { telegram: { accounts: { work: { allowFrom: ["123"] } } } },
            },
          });
          addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
            changed: true,
            allowFrom: ["123", "789"],
          });

          const params = buildAllowlistParams(
            "/allowlist add dm --account work 789",
            {
              commands: { text: true, config: true },
              channels: { telegram: { accounts: { work: { allowFrom: ["123"] } } } },
            } as OpenClawConfig,
            { AccountId: "work" },
          );
          params.command.senderIsOwner = true;
          const result = await handleAllowlistCommand(params, true);

          expect(result?.shouldContinue, "selected account scope").toBe(false);
          expect(addChannelAllowFromStoreEntryMock, "selected account scope").toHaveBeenCalledWith({
            channel: "telegram",
            entry: "789",
            accountId: "work",
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("uses the configured default account for omitted-account list", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...telegramAllowlistTestPlugin,
            config: {
              ...telegramAllowlistTestPlugin.config,
              defaultAccountId: (cfg: OpenClawConfig) =>
                (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
                DEFAULT_ACCOUNT_ID,
            },
          },
        },
      ]),
    );

    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: { work: { allowFrom: ["123"] } },
        },
      },
    } as OpenClawConfig;
    readChannelAllowFromStoreMock.mockResolvedValueOnce([]);

    const result = await handleAllowlistCommand(
      buildAllowlistParams("/allowlist list dm", cfg, {
        Provider: "telegram",
        Surface: "telegram",
      }),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: telegram (account work)");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123");
  });

  it("blocks config-targeted edits when the target account disables writes", async () => {
    const previousWriteCount = replaceConfigFileMock.mock.calls.length;
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: {
          configWrites: true,
          accounts: {
            work: { configWrites: false, allowFrom: ["123"] },
          },
        },
      },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    const params = buildAllowlistParams("/allowlist add dm --account work --config 789", cfg, {
      AccountId: "default",
      Provider: "telegram",
      Surface: "telegram",
    });
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(replaceConfigFileMock.mock.calls.length).toBe(previousWriteCount);
  });

  it("honors the configured default account when gating omitted-account config edits", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...telegramAllowlistTestPlugin,
            config: {
              ...telegramAllowlistTestPlugin.config,
              defaultAccountId: (cfg: OpenClawConfig) =>
                (cfg.channels?.telegram as TelegramTestSectionConfig | undefined)?.defaultAccount ??
                DEFAULT_ACCOUNT_ID,
            },
          },
        },
      ]),
    );

    const previousWriteCount = replaceConfigFileMock.mock.calls.length;
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: {
          defaultAccount: "work",
          configWrites: true,
          accounts: {
            work: { configWrites: false, allowFrom: ["123"] },
          },
        },
      },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    const params = buildAllowlistParams("/allowlist add dm --config 789", cfg, {
      Provider: "telegram",
      Surface: "telegram",
    });
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(replaceConfigFileMock.mock.calls.length).toBe(previousWriteCount);
  });

  it("blocks allowlist writes from authorized non-owner senders", async () => {
    const cfg = {
      commands: {
        text: true,
        config: true,
        allowFrom: { telegram: ["*"] },
        ownerAllowFrom: ["discord:owner-discord-id"],
      },
      channels: {
        telegram: { allowFrom: ["*"], configWrites: true },
        discord: { allowFrom: ["owner-discord-id"], configWrites: true },
      },
    } as OpenClawConfig;
    const params = buildAllowlistParams(
      "/allowlist add dm --channel discord attacker-discord-id",
      cfg,
      {
        Provider: "telegram",
        Surface: "telegram",
        SenderId: "telegram-attacker",
        From: "telegram-attacker",
      },
    );
    params.command.senderIsOwner = false;

    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks a cross-channel write from an origin-only owner (#104984)", async () => {
    // No commands.ownerAllowFrom, so owner authority falls back to each
    // channel's allowFrom. The Telegram sender is an owner ON TELEGRAM only and
    // must not be able to rewrite WhatsApp's allowlist via --channel.
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: { allowFrom: ["123456789"], configWrites: true },
        whatsapp: { allowFrom: ["+15550000000"], configWrites: true },
      },
    } as OpenClawConfig;
    // Full write-path mocks so that, absent the guard, the WhatsApp write would
    // succeed — the guard is the only thing that blocks it (a true discriminator).
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    const params = buildAllowlistParams("/allowlist add dm --channel whatsapp +15551234567", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      SenderId: "123456789",
      From: "123456789",
    });
    // Origin (Telegram) owner authority — the pre-fix state that let this through.
    params.command.senderIsOwner = true;

    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    // The WhatsApp allowlist must not be mutated by a Telegram-only owner.
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("allows a cross-channel write from a global commands owner (#104984)", async () => {
    // A global commands.ownerAllowFrom identity is an owner everywhere, so a
    // legitimate operator can still edit another channel cross-surface.
    const cfg = {
      commands: {
        text: true,
        config: true,
        ownerAllowFrom: ["telegram:123456789"],
      },
      channels: {
        telegram: { allowFrom: ["123456789"], configWrites: true },
        whatsapp: { allowFrom: ["+15550000000"], configWrites: true },
      },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    const params = buildAllowlistParams("/allowlist add dm --channel whatsapp +15551234567", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      SenderId: "123456789",
      From: "123456789",
    });
    params.command.senderIsOwner = true;

    const result = await handleAllowlistCommand(params, true);

    // Global owner passes the cross-channel gate and reaches the write path.
    expect(result?.reply?.text ?? "").not.toContain("not authorized");
  });

  it("blocks non-owner allowlist writes before resolving target channel", async () => {
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: { allowFrom: ["*"], configWrites: true },
      },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist add dm --channel unknown attacker-id", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      SenderId: "telegram-attacker",
      From: "telegram-attacker",
    });
    params.command.senderIsOwner = false;

    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply).toBeUndefined();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks cross-channel config edits when the command origin disables writes", async () => {
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: { allowFrom: ["123"], configWrites: false },
        discord: { allowFrom: ["456"], configWrites: true },
      },
    } as OpenClawConfig;
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    // The sender is a genuine discord owner (id 456) so the cross-channel owner
    // gate passes and the test isolates the origin configWrites denial.
    const params = buildAllowlistParams("/allowlist add dm --channel discord --config 789", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      SenderId: "456",
      From: "456",
    });
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.default.configWrites=true");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks store-targeted allowlist edits when channel configWrites is false", async () => {
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: {
          allowFrom: ["123"],
          configWrites: false,
        },
      },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist add dm --store 789", cfg);
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.default.configWrites=true");
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks store-targeted allowlist edits when account configWrites is false", async () => {
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: {
          configWrites: true,
          accounts: {
            work: { configWrites: false, allowFrom: ["123"] },
          },
        },
      },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist add dm --store --account work 789", cfg, {
      AccountId: "work",
    });
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks cross-channel store edits when the command origin disables writes", async () => {
    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: { allowFrom: ["123"], configWrites: false },
        discord: { allowFrom: ["456"], configWrites: true },
      },
    } as OpenClawConfig;
    // Sender is a genuine discord owner (id 456), isolating the configWrites gate.
    const params = buildAllowlistParams("/allowlist add dm --channel discord --store 789", cfg, {
      Provider: "telegram",
      Surface: "telegram",
      SenderId: "456",
      From: "456",
    });
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.default.configWrites=true");
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("allows store-targeted allowlist edits when configWrites is true", async () => {
    addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
      changed: true,
      allowFrom: ["789"],
    });

    const cfg = {
      commands: { text: true, config: true },
      channels: {
        telegram: {
          allowFrom: ["123"],
          configWrites: true,
        },
      },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist add dm --store 789", cfg);
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("DM allowlist added in pairing store");
    expect(addChannelAllowFromStoreEntryMock).toHaveBeenCalledWith({
      channel: "telegram",
      entry: "789",
      accountId: "default",
    });
  });

  it("removes default-account entries from scoped and legacy pairing stores", async () => {
    removeChannelAllowFromStoreEntryMock
      .mockResolvedValueOnce({
        changed: true,
        allowFrom: [],
      })
      .mockResolvedValueOnce({
        changed: true,
        allowFrom: [],
      });

    const cfg = {
      commands: { text: true, config: true },
      channels: { telegram: { allowFrom: ["123"] } },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist remove dm --store 789", cfg);
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(removeChannelAllowFromStoreEntryMock).toHaveBeenNthCalledWith(1, {
      channel: "telegram",
      entry: "789",
      accountId: "default",
    });
    expect(removeChannelAllowFromStoreEntryMock).toHaveBeenNthCalledWith(2, {
      channel: "telegram",
      entry: "789",
    });
  });

  it("rejects blocked account ids and keeps Object.prototype clean", async () => {
    delete (Object.prototype as Record<string, unknown>).allowFrom;

    const cfg = {
      commands: { text: true, config: true },
      channels: { telegram: { allowFrom: ["123"] } },
    } as OpenClawConfig;
    const params = buildAllowlistParams("/allowlist add dm --account __proto__ 789", cfg);
    params.command.senderIsOwner = true;
    const result = await handleAllowlistCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Invalid account id");
    expect((Object.prototype as Record<string, unknown>).allowFrom).toBeUndefined();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("removes DM allowlist entries from canonical allowFrom and deletes legacy dm.allowFrom", async () => {
    const cases = [
      {
        provider: "slack",
        removeId: "U111",
        initialAllowFrom: ["U111", "U222"],
        expectedAllowFrom: ["U222"],
      },
      {
        provider: "discord",
        removeId: "111",
        initialAllowFrom: ["111", "222"],
        expectedAllowFrom: ["222"],
      },
    ] as const;

    for (const testCase of cases) {
      const initialConfig = {
        channels: {
          [testCase.provider]: {
            allowFrom: testCase.initialAllowFrom,
            dm: { allowFrom: testCase.initialAllowFrom },
            configWrites: true,
          },
        },
      };
      await withTempConfigPath(initialConfig, async (configPath) => {
        readConfigFileSnapshotMock.mockResolvedValueOnce({
          valid: true,
          parsed: structuredClone(initialConfig),
        });

        const cfg = {
          commands: { text: true, config: true },
          channels: {
            [testCase.provider]: {
              allowFrom: testCase.initialAllowFrom,
              dm: { allowFrom: testCase.initialAllowFrom },
              configWrites: true,
            },
          },
        } as OpenClawConfig;

        const params = buildAllowlistParams(`/allowlist remove dm ${testCase.removeId}`, cfg, {
          Provider: testCase.provider,
          Surface: testCase.provider,
        });
        params.command.senderIsOwner = true;
        const result = await handleAllowlistCommand(params, true);

        expect(result?.shouldContinue).toBe(false);
        const written = await readJsonFile<OpenClawConfig>(configPath);
        const channelConfig = written.channels?.[testCase.provider];
        expect(channelConfig?.allowFrom).toEqual(testCase.expectedAllowFrom);
        expect(channelConfig?.dm?.allowFrom).toBeUndefined();
        expect(result?.reply?.text).toContain(`channels.${testCase.provider}.allowFrom`);
      });
    }
  });
});
