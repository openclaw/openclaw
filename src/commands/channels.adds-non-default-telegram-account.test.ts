import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPatchedAccountSetupAdapter } from "../channels/plugins/setup-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createScopedChannelConfigAdapter } from "../plugin-sdk/channel-config-helpers.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { configMocks, offsetMocks, secretMocks } from "./channels.mock-harness.js";
import { channelsAddCommand } from "./channels/add.js";
import { channelsRemoveCommand } from "./channels/remove.js";
import {
  baseConfigSnapshot,
  createTestConfigSnapshot,
  createTestRuntime,
} from "./test-runtime-config-helpers.js";

vi.mock("./channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: () => [],
  resolveTrustedChannelCatalogInput: () => undefined,
}));
const runtime = createTestRuntime();
const plugin = {
  ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
  config: createScopedChannelConfigAdapter({
    sectionKey: "telegram",
    listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? { default: {} }),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.telegram?.accounts?.[accountId ?? "default"] ?? cfg.channels?.telegram,
    defaultAccountId: () => "default",
    clearBaseFields: ["botToken", "name", "dmPolicy", "allowFrom", "groupPolicy", "streaming"],
    resolveAllowFrom: () => [],
    formatAllowFrom: (allowFrom) => allowFrom.map(String),
  }),
  setup: {
    ...createPatchedAccountSetupAdapter({
      channelKey: "telegram",
      buildPatch: (input) => (input.token ? { botToken: input.token } : {}),
    }),
    namedAccountPromotionKeys: ["botToken", "tokenFile"],
    singleAccountKeysToMove: ["streaming"],
  },
  lifecycle: {
    onAccountRemoved: async ({ accountId }: { accountId: string }) => {
      await offsetMocks.deleteTelegramUpdateOffset({ accountId });
    },
  },
};
function getWrittenConfig(): OpenClawConfig {
  expect(configMocks.writeConfigFile).toHaveBeenCalledOnce();
  return configMocks.writeConfigFile.mock.calls[0]?.[0];
}
async function addTelegramAccount(account: string, token: string) {
  await channelsAddCommand({ channel: "telegram", account, token }, runtime, { hasFlags: true });
}
async function addAlertsTelegramAccount(token: string) {
  await addTelegramAccount("alerts", token);
  return getWrittenConfig();
}
describe("channel account promotion and removal", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    secretMocks.resolveCommandConfigWithSecrets.mockClear();
    offsetMocks.deleteTelegramUpdateOffset.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
  });
  it("moves single-account telegram config into accounts.default when adding non-default", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            enabled: true,
            botToken: "legacy-token",
            dmPolicy: "allowlist",
            allowFrom: ["111"],
            groupPolicy: "allowlist",
            streaming: "partial",
          },
        },
      },
    });

    await addTelegramAccount("alerts", "alerts-token");

    const next = getWrittenConfig();
    expect(next.channels?.telegram?.accounts?.default).toEqual({
      botToken: "legacy-token",
      dmPolicy: "allowlist",
      allowFrom: ["111"],
      groupPolicy: "allowlist",
      streaming: "partial",
    });
    expect(next.channels?.telegram?.botToken).toBeUndefined();
    expect(next.channels?.telegram?.dmPolicy).toBeUndefined();
    expect(next.channels?.telegram?.allowFrom).toBeUndefined();
    expect(next.channels?.telegram?.groupPolicy).toBeUndefined();
    expect(next.channels?.telegram?.streaming).toBeUndefined();
    expect(next.channels?.telegram?.accounts?.alerts?.botToken).toBe("alerts-token");
  });

  it("seeds accounts.default for env-only single-account telegram config when adding non-default", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });

    const next = await addAlertsTelegramAccount("alerts-token");
    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.accounts?.default).toStrictEqual({});
    expect(next.channels?.telegram?.accounts?.alerts?.botToken).toBe("alerts-token");
  });

  it("cleans up telegram update offset when deleting a telegram account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          telegram: { botToken: "123:abc", enabled: true },
        },
      }),
    );

    await channelsRemoveCommand(
      { channel: "telegram", account: "default", delete: true },
      runtime,
      {
        hasFlags: true,
      },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledWith({ accountId: "default" });
  });
});
