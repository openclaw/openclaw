import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
type ConfigEdit = { nextConfig: OpenClawConfig; result?: unknown };

// mock-isolation: Keep config reads and conditional writes inside the command fixture.
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
    ) => ConfigEdit | Promise<ConfigEdit>;
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
  readConfigFileSnapshotMock.mockImplementation(async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      return { valid: false, parsed: null };
    }
    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    return { valid: true, parsed };
  });
  validateConfigObjectWithPluginsMock.mockImplementation((value: unknown) => ({
    ok: true,
    config: value,
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

describe("handleAllowlistCommand", () => {
  it("lists config and store allowFrom entries", async () => {
    readChannelAllowFromStoreMock.mockResolvedValueOnce(["456"]);

    const result = await listAllowlist(
      config({ telegram: { allowFrom: ["123", "@Alice"] } }, false),
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: telegram");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123, @alice");
    expect(result?.reply?.text).toContain("Paired allowFrom (store): 456");
  });

  it("surfaces pairing-store read failures instead of an empty store list", async () => {
    readChannelAllowFromStoreMock.mockRejectedValueOnce(new Error("pairing db locked"));

    const result = await listAllowlist(config({ telegram: { allowFrom: ["123"] } }, false));

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(
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
      await withTempConfigPath(cfg, async (configPath) => {
        readConfigFileSnapshotMock.mockResolvedValueOnce({ valid: true, parsed: cfg });
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
          const written = await readJsonFile<OpenClawConfig>(configPath);
          expect(written.channels?.telegram?.allowFrom, accountId).toEqual(["123", "789"]);
          expect(result?.reply?.text, accountId).toContain("DM allowlist added");
        }
      });
    }
  });

  it("keeps group allowlist edits out of the DM pairing store", async () => {
    const cfg = config({ telegram: { groupAllowFrom: ["123"] } });
    await withTempConfigPath({ channels: cfg.channels }, async (configPath) => {
      const result = await runOwnerCommand("/allowlist add group 789", cfg);

      expect(result?.shouldContinue).toBe(false);
      const written = await readJsonFile<OpenClawConfig>(configPath);
      expect(written.channels?.telegram?.groupAllowFrom).toEqual(["123", "789"]);
      expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
      expect(result?.reply?.text).toContain(
        "group allowlist added: channels.telegram.groupAllowFrom.",
      );
      expect(result?.reply?.text).not.toContain("pairing store");
    });
  });

  it("uses the configured default account for omitted-account list", async () => {
    const cfg = config({
      telegram: {
        defaultAccount: "work",
        accounts: { work: { allowFrom: ["123"] } },
      },
    });
    readChannelAllowFromStoreMock.mockResolvedValueOnce([]);

    const result = await listAllowlist(cfg);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Channel: telegram (account work)");
    expect(result?.reply?.text).toContain("DM allowFrom (config): 123");
  });

  it("blocks config-targeted edits when the target account disables writes", async () => {
    const cfg = config({
      telegram: {
        configWrites: true,
        accounts: { work: { configWrites: false, allowFrom: ["123"] } },
      },
    });
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    const result = await runOwnerCommand("/allowlist add dm --account work --config 789", cfg, {
      AccountId: "default",
    });

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.work.configWrites=true");
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

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("commands.ownerAllowFrom");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks cross-channel config edits when the command origin disables writes", async () => {
    const cfg = config({
      telegram: { allowFrom: ["123"], configWrites: false },
      discord: { allowFrom: ["456"], configWrites: true },
    });
    readConfigFileSnapshotMock.mockResolvedValueOnce({
      valid: true,
      parsed: structuredClone(cfg),
    });
    const result = await runOwnerCommand("/allowlist add dm --channel discord --config 789", cfg);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.default.configWrites=true");
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("blocks cross-channel store edits when the command origin disables writes", async () => {
    const cfg = config({
      telegram: { allowFrom: ["123"], configWrites: false },
      discord: { allowFrom: ["456"], configWrites: true },
    });
    const result = await runOwnerCommand("/allowlist add dm --channel discord --store 789", cfg);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("channels.telegram.accounts.default.configWrites=true");
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("rejects group-scoped store edits because pairing stores authorize DMs only", async () => {
    const cfg = config({ telegram: { allowFrom: ["123"], configWrites: true } });
    const result = await runOwnerCommand("/allowlist add group --store 789", cfg);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Pairing-store allowlist edits apply to DMs only");
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(addChannelAllowFromStoreEntryMock).not.toHaveBeenCalled();
  });

  it("removes default-account entries from scoped and legacy pairing stores", async () => {
    const cfg = config({ telegram: { allowFrom: ["123"] } });
    const result = await runOwnerCommand("/allowlist remove dm --store 789", cfg);

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

    const cfg = config({ telegram: { allowFrom: ["123"] } });
    const result = await runOwnerCommand("/allowlist add dm --account __proto__ 789", cfg);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Invalid account id");
    expect((Object.prototype as Record<string, unknown>).allowFrom).toBeUndefined();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
  });
});
