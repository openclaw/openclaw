import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
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
import { handleAllowlistCommand } from "./commands-allowlist.js";
import type { HandleCommandsParams } from "./commands-types.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());
const addChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
const removeChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
type ConfigEdit = { nextConfig: OpenClawConfig; result?: unknown };

// mock-isolation: Keep config reads and conditional writes inside the command fixture.
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  replaceConfigFile: replaceConfigFileMock,
  transformConfigFileWithRetry: async (params: {
    afterWrite?: unknown;
    transform: (currentConfig: OpenClawConfig) => ConfigEdit | Promise<ConfigEdit>;
  }) => {
    const { parsed } = await readConfigFileSnapshotMock();
    const transformed = await params.transform(structuredClone(parsed));
    const afterWrite = params.afterWrite ?? { mode: "auto" };
    await replaceConfigFileMock({ nextConfig: transformed.nextConfig, afterWrite });
  },
}));

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
  addChannelAllowFromStoreEntry: addChannelAllowFromStoreEntryMock,
  removeChannelAllowFromStoreEntry: removeChannelAllowFromStoreEntryMock,
}));

type TelegramTestSectionConfig = {
  allowFrom?: string[];
  groupAllowFrom?: string[];
  defaultAccount?: string;
  configWrites?: boolean;
  accounts?: Record<string, TelegramTestSectionConfig>;
};

type DmGroupAllowlistTestSectionConfig = {
  allowFrom?: string[];
  dm?: { allowFrom?: string[] };
};

function normalizeTelegramAllowFromEntries(values: Array<string | number>): string[] {
  return formatAllowFromLowercase({ allowFrom: values, stripPrefixRe: /^(telegram|tg):/i });
}

const normalizeAllowlistValues = (values: Array<string | number>): string[] =>
  values.map((value) => String(value).trim()).filter(Boolean);

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
  pairing: { idLabel: "telegramUserId" },
  allowlist: buildDmGroupAccountAllowlistAdapter({
    channelId: "telegram",
    resolveAccount: ({ cfg, accountId }) => resolveTelegramTestAccount(cfg, accountId),
    normalize: ({ values }) => normalizeTelegramAllowFromEntries(values),
    resolveDmAllowFrom: (account) => account.allowFrom,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
  }),
};

function createLegacyAllowlistPlugin(): ChannelPlugin {
  const channelId = "discord";
  return {
    ...createChannelTestPluginBase({
      id: channelId,
      label: "Discord",
      capabilities: {
        chatTypes: ["direct", "group", "thread"],
        nativeCommands: true,
      },
    }),
    pairing: { idLabel: "discordUserId" },
    allowlist: buildLegacyDmAccountAllowlistAdapter({
      channelId,
      resolveAccount: ({ cfg }) =>
        (cfg.channels?.[channelId] as DmGroupAllowlistTestSectionConfig | undefined) ?? {},
      normalize: ({ values }) => normalizeAllowlistValues(values),
      resolveDmAllowFrom: (account) => account.allowFrom ?? account.dm?.allowFrom,
    }),
  };
}

function setAllowlistPluginRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: telegramAllowlistTestPlugin, source: "test" },
      { pluginId: "discord", plugin: createLegacyAllowlistPlugin(), source: "test" },
    ]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setAllowlistPluginRegistry();
  readConfigFileSnapshotMock.mockResolvedValue({ valid: false, parsed: null });
  validateConfigObjectWithPluginsMock.mockImplementation((value: unknown) => ({
    ok: true,
    config: value,
  }));
  replaceConfigFileMock.mockResolvedValue(undefined);
  readChannelAllowFromStoreMock.mockResolvedValue([]);
  addChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
  removeChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
});

function buildAllowlistParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<
    Pick<
      HandleCommandsParams["ctx"],
      "Provider" | "Surface" | "AccountId" | "SenderId" | "From" | "GatewayClientScopes"
    >
  >,
): HandleCommandsParams {
  const provider = ctxOverrides?.Provider ?? "telegram";
  return {
    cfg,
    ctx: {
      Provider: provider,
      Surface: ctxOverrides?.Surface ?? provider,
      CommandSource: "text",
      ...ctxOverrides,
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

function config(channels: OpenClawConfig["channels"], editable = true): OpenClawConfig {
  return { commands: editable ? { text: true, config: true } : { text: true }, channels };
}

function runOwnerCommand(
  body: string,
  cfg: OpenClawConfig,
  ctx?: Parameters<typeof buildAllowlistParams>[2],
) {
  const params = buildAllowlistParams(body, cfg, ctx);
  params.command.senderIsOwner = true;
  return handleAllowlistCommand(params, true);
}

const listAllowlist = (cfg: OpenClawConfig) =>
  handleAllowlistCommand(buildAllowlistParams("/allowlist list dm", cfg), true);

function expectReply(result: Awaited<ReturnType<typeof handleAllowlistCommand>>, text: string) {
  expect(result?.shouldContinue).toBe(false);
  expect(result?.reply?.text).toContain(text);
}

function mockConfigSnapshot(cfg: OpenClawConfig) {
  readConfigFileSnapshotMock.mockResolvedValue({ valid: true, parsed: structuredClone(cfg) });
}

describe("handleAllowlistCommand", () => {
  it("lists config and store allowFrom entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValueOnce(["456"]);

    const result = await listAllowlist(
      config({ telegram: { allowFrom: ["123", "@Alice"] } }, false),
    );

    expectReply(result, "Channel: telegram");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123, @alice");
    expect(result?.reply?.text).toContain("Paired allowFrom (store): 456");
  });

  it("surfaces pairing-store read failures instead of an empty store list", async () => {
    readChannelAllowFromStoreMock.mockRejectedValueOnce(new Error("pairing db locked"));

    const result = await listAllowlist(config({ telegram: { allowFrom: ["123"] } }, false));

    expectReply(
      result,
      "Paired allowFrom (store): unavailable (read failed). Retry this command; if it still fails, run openclaw doctor.",
    );
  });

  it("adds allowlist entries to config and pairing stores", async () => {
    for (const accountId of ["default", "work"]) {
      const telegram =
        accountId === "default"
          ? { allowFrom: ["123"] }
          : { accounts: { work: { allowFrom: ["123"] } } };
      const cfg = config({ telegram });
      mockConfigSnapshot(cfg);
      addChannelAllowFromStoreEntryMock.mockResolvedValueOnce({
        changed: true,
        allowFrom: ["123", "789"],
      });
      const accountFlag = accountId === "default" ? "" : "--account work ";
      const result = await runOwnerCommand(
        `/allowlist add dm ${accountFlag}789`,
        cfg,
        accountId === "default" ? undefined : { AccountId: "work" },
      );
      expect(result?.shouldContinue, accountId).toBe(false);
      expect(addChannelAllowFromStoreEntryMock, accountId).toHaveBeenCalledWith({
        channel: "telegram",
        entry: "789",
        accountId,
      });
      if (accountId === "default") {
        expect(replaceConfigFileMock).toHaveBeenLastCalledWith({
          nextConfig: { ...cfg, channels: { telegram: { allowFrom: ["123", "789"] } } },
          afterWrite: { mode: "auto" },
        });
        expect(result?.reply?.text, accountId).toContain("DM allowlist added");
      }
    }
  });

  it("keeps group allowlist edits out of the DM pairing store", async () => {
    const cfg = config({ telegram: { groupAllowFrom: ["123"] } });
    mockConfigSnapshot({ channels: cfg.channels });
    const result = await runOwnerCommand("/allowlist add group 789", cfg);

    expectReply(result, "group allowlist added: channels.telegram.groupAllowFrom.");
    expect(replaceConfigFileMock).toHaveBeenLastCalledWith({
      nextConfig: { channels: { telegram: { groupAllowFrom: ["123", "789"] } } },
      afterWrite: { mode: "auto" },
    });
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).not.toContain("pairing store");
  });

  it("uses the configured default account for omitted-account list", async () => {
    const cfg = config({
      telegram: { defaultAccount: "work", accounts: { work: { allowFrom: ["123"] } } },
    });
    readChannelAllowFromStoreMock.mockResolvedValueOnce([]);

    const result = await listAllowlist(cfg);

    expectReply(result, "Channel: telegram (account work)");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123");
  });

  it("blocks config-targeted edits when the target account disables writes", async () => {
    const cfg = config({
      telegram: {
        configWrites: true,
        accounts: { work: { configWrites: false, allowFrom: ["123"] } },
      },
    });
    mockConfigSnapshot(cfg);
    const result = await runOwnerCommand("/allowlist add dm --account work --config 789", cfg, {
      AccountId: "default",
    });

    expectReply(result, "channels.telegram.accounts.work.configWrites=true");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });

  it("blocks non-owner allowlist writes before resolving target channel", async () => {
    const cfg = config({ telegram: { allowFrom: ["*"], configWrites: true } });
    const params = buildAllowlistParams("/allowlist add dm --channel unknown attacker-id", cfg, {
      SenderId: "telegram-attacker",
      From: "telegram-attacker",
    });
    params.command.senderIsOwner = false;

    const result = await handleAllowlistCommand(params, true);

    expectReply(result, "commands.ownerAllowFrom");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it.each(["config", "store"])(
    "blocks cross-channel %s edits when the command origin disables writes",
    async (target) => {
      const cfg = config({
        telegram: { allowFrom: ["123"], configWrites: false },
        discord: { allowFrom: ["456"], configWrites: true },
      });
      if (target === "config") {
        mockConfigSnapshot(cfg);
      }
      const result = await runOwnerCommand(
        `/allowlist add dm --channel discord --${target} 789`,
        cfg,
      );

      expectReply(result, "channels.telegram.accounts.default.configWrites=true");
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
    },
  );

  it("rejects group-scoped store edits because pairing stores authorize DMs only", async () => {
    const cfg = config({ telegram: { allowFrom: ["123"], configWrites: true } });
    const result = await runOwnerCommand("/allowlist add group --store 789", cfg);

    expectReply(result, "Pairing-store allowlist edits apply to DMs only");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("rejects blocked account ids and keeps Object.prototype clean", async () => {
    delete (Object.prototype as Record<string, unknown>).allowFrom;

    const cfg = config({ telegram: { allowFrom: ["123"] } });
    const result = await runOwnerCommand("/allowlist add dm --account __proto__ 789", cfg);

    expectReply(result, "Invalid account id");
    expect((Object.prototype as Record<string, unknown>).allowFrom).toBeUndefined();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });
});
