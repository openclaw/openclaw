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
const replaceConfigFileMock = vi.hoisted(() => vi.fn());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());
const addChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
const removeChannelAllowFromStoreEntryMock = vi.hoisted(() => vi.fn());
type ConfigEdit = { nextConfig: OpenClawConfig; result?: unknown };

// mock-isolation: Keep config reads and conditional writes inside the command fixture.
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: (value: unknown) => ({ ok: true, config: value }),
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

function normalizeTelegramAllowFromEntries(values: Array<string | number>): string[] {
  return formatAllowFromLowercase({ allowFrom: values, stripPrefixRe: /^(telegram|tg):/i });
}

function resolveTelegramTestAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const section = cfg.channels?.telegram;
  return accountId && accountId !== DEFAULT_ACCOUNT_ID
    ? { ...section, ...section?.accounts?.[accountId] }
    : (section ?? {});
}

const telegramAllowlistTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({ id: "telegram" }),
  config: createScopedChannelConfigAdapter({
    sectionKey: "telegram",
    listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? { default: {} }),
    resolveAccount: resolveTelegramTestAccount,
    defaultAccountId: (cfg) => cfg.channels?.telegram?.defaultAccount ?? DEFAULT_ACCOUNT_ID,
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

const discordAllowlistTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({ id: "discord" }),
  pairing: { idLabel: "discordUserId" },
  allowlist: buildLegacyDmAccountAllowlistAdapter({
    channelId: "discord",
    resolveAccount: ({ cfg }) => cfg.channels?.discord ?? {},
    normalize: ({ values }) => values.map((value) => String(value).trim()).filter(Boolean),
    resolveDmAllowFrom: (account) => account.allowFrom,
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "telegram", plugin: telegramAllowlistTestPlugin, source: "test" },
      { pluginId: "discord", plugin: discordAllowlistTestPlugin, source: "test" },
    ]),
  );
  readConfigFileSnapshotMock.mockResolvedValue({ valid: false, parsed: null });
  replaceConfigFileMock.mockResolvedValue(undefined);
  readChannelAllowFromStoreMock.mockResolvedValue([]);
  addChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
  removeChannelAllowFromStoreEntryMock.mockResolvedValue({ changed: true, allowFrom: [] });
});

function buildAllowlistParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<Pick<HandleCommandsParams["ctx"], "AccountId" | "SenderId" | "From">>,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      CommandSource: "text",
      ...ctxOverrides,
    },
    command: {
      commandBodyNormalized: commandBody,
      isAuthorizedSender: true,
      senderIsOwner: false,
      senderId: ctxOverrides?.SenderId ?? "owner",
      channel: "telegram",
      channelId: "telegram",
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
    const cfg = config({ telegram: { allowFrom: ["123"] } });
    mockConfigSnapshot(cfg);
    const result = await runOwnerCommand("/allowlist add dm 789", cfg);
    expectReply(result, "DM allowlist added");
    expect(addChannelAllowFromStoreEntryMock).toHaveBeenCalledWith({
      channel: "telegram",
      entry: "789",
      accountId: "default",
    });
    expect(replaceConfigFileMock).toHaveBeenLastCalledWith({
      nextConfig: { ...cfg, channels: { telegram: { allowFrom: ["123", "789"] } } },
      afterWrite: { mode: "auto" },
    });
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

  it.each([
    [
      "account",
      "add dm --account work --config 789",
      "channels.telegram.accounts.work.configWrites=true",
    ],
    ["non-owner", "add dm --channel unknown attacker-id", "commands.ownerAllowFrom"],
    [
      "cross-config",
      "add dm --channel discord --config 789",
      "channels.telegram.accounts.default.configWrites=true",
    ],
    [
      "cross-store",
      "add dm --channel discord --store 789",
      "channels.telegram.accounts.default.configWrites=true",
    ],
    ["group", "add group --store 789", "Pairing-store allowlist edits apply to DMs only"],
    ["reserved", "add dm --account __proto__ 789", "Invalid account id"],
  ] as const)("rejects %s allowlist writes before mutation", async (kind, command, message) => {
    const crossChannel = kind.startsWith("cross-");
    const telegram =
      kind === "account"
        ? { configWrites: true, accounts: { work: { configWrites: false, allowFrom: ["123"] } } }
        : {
            allowFrom: [kind === "non-owner" ? "*" : "123"],
            ...(kind === "reserved" ? {} : { configWrites: !crossChannel }),
          };
    const cfg = config({
      telegram,
      ...(crossChannel ? { discord: { allowFrom: ["456"], configWrites: true } } : {}),
    });
    if (kind === "account" || kind === "cross-config") {
      mockConfigSnapshot(cfg);
    }
    if (kind === "reserved") {
      delete (Object.prototype as Record<string, unknown>).allowFrom;
    }
    const params = buildAllowlistParams(
      `/allowlist ${command}`,
      cfg,
      kind === "non-owner"
        ? { SenderId: "telegram-attacker", From: "telegram-attacker" }
        : kind === "account"
          ? { AccountId: "default" }
          : undefined,
    );
    params.command.senderIsOwner = kind !== "non-owner";
    expectReply(await handleAllowlistCommand(params, true), message);
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
    if (kind === "group") {
      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    }
    if (kind === "reserved") {
      expect((Object.prototype as Record<string, unknown>).allowFrom).toBeUndefined();
    }
  });
});
