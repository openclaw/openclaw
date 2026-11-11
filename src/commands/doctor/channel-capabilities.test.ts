// Doctor channel capability tests cover channel capability inspection and diagnostics.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectChannelDmPolicyDependencyWarnings } from "../../config/validation-channel-rules.js";
import {
  getDoctorChannelCapabilities,
  resolveDoctorChannelAccountIds,
} from "./channel-capabilities.js";

const channelPluginMocks = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn(() => undefined),
  getChannelPlugin: vi.fn(() => undefined),
}));

const readOnlyPluginMocks = vi.hoisted(() => ({
  resolveReadOnlyChannelPluginsForConfig: vi.fn(
    (): { plugins: Array<Record<string, unknown>> } => ({ plugins: [] }),
  ),
}));

vi.mock("../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: channelPluginMocks.getBundledChannelPlugin,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: channelPluginMocks.getChannelPlugin,
}));

vi.mock("../../channels/plugins/read-only.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../channels/plugins/read-only.js")>();
  return {
    ...actual,
    resolveReadOnlyChannelPluginsForConfig:
      readOnlyPluginMocks.resolveReadOnlyChannelPluginsForConfig,
  };
});

function expectCapabilities(
  channelId: string,
  expected: readonly [
    dmAllowFromMode: string,
    groupModel: string,
    groupAllowFromFallbackToAllowFrom: boolean,
    warnOnEmptyGroupSenderAllowlist: boolean,
  ],
) {
  const [
    dmAllowFromMode,
    groupModel,
    groupAllowFromFallbackToAllowFrom,
    warnOnEmptyGroupSenderAllowlist,
  ] = expected;
  expect(getDoctorChannelCapabilities(channelId)).toEqual({
    dmAllowFromMode,
    groupModel,
    groupAllowFromFallbackToAllowFrom,
    warnOnEmptyGroupSenderAllowlist,
  });
}

describe("doctor channel capabilities", () => {
  beforeEach(() => {
    channelPluginMocks.getBundledChannelPlugin.mockReset().mockReturnValue(undefined);
    channelPluginMocks.getChannelPlugin.mockReset().mockReturnValue(undefined);
    readOnlyPluginMocks.resolveReadOnlyChannelPluginsForConfig
      .mockReset()
      .mockReturnValue({ plugins: [] });
  });

  it("returns canonical top-level route semantics from googlechat plugin metadata", () => {
    expectCapabilities("googlechat", ["topOnly", "route", false, false]);
  });

  it("retains root and account Google Chat DM-policy safety warnings", () => {
    const dmAllowFromMode = getDoctorChannelCapabilities("googlechat").dmAllowFromMode;
    const warnings = collectChannelDmPolicyDependencyWarnings(
      {
        channels: {
          googlechat: {
            dmPolicy: "open",
            allowFrom: ["users/123"],
            accounts: {
              work: {
                dmPolicy: "open",
                allowFrom: ["users/456"],
              },
            },
          },
        },
      },
      { dmPolicyMetadata: new Map([["googlechat", { id: "googlechat", dmAllowFromMode }]]) },
    );

    expect(warnings.map(({ path }) => path)).toEqual([
      "channels.googlechat.allowFrom",
      "channels.googlechat.accounts.work.allowFrom",
    ]);
  });

  it("retains empty allowlist warnings when open DMs do not require a wildcard", () => {
    const warnings = collectChannelDmPolicyDependencyWarnings(
      { channels: { qqbot: { dmPolicy: "allowlist", allowFrom: [] } } },
      {
        dmPolicyMetadata: new Map([
          ["qqbot", { id: "qqbot", openDmRequiresAllowFromWildcard: false }],
        ]),
      },
    );

    expect(warnings).toContainEqual(
      expect.objectContaining({
        path: "channels.qqbot.allowFrom",
        message: expect.stringContaining('channels.qqbot.dmPolicy="allowlist"'),
      }),
    );
  });

  it("returns Slack route semantics without loading its channel plugin", () => {
    expectCapabilities("slack", ["topOnly", "route", false, false]);
  });

  it("returns Discord route semantics without loading its channel plugin", () => {
    expectCapabilities("discord", ["topOnly", "route", false, false]);
    expect(channelPluginMocks.getChannelPlugin).not.toHaveBeenCalled();
    expect(channelPluginMocks.getBundledChannelPlugin).not.toHaveBeenCalled();
  });

  it.each(["telegram"])(
    "returns %s sender semantics without loading its channel plugin",
    (channelId) => {
      expectCapabilities(channelId, ["topOnly", "sender", true, true]);
      expect(channelPluginMocks.getChannelPlugin).not.toHaveBeenCalled();
      expect(channelPluginMocks.getBundledChannelPlugin).not.toHaveBeenCalled();
    },
  );

  it("returns sender-scoped group semantics for line without a DM allowlist fallback", () => {
    expectCapabilities("line", ["topOnly", "sender", false, true]);
  });

  it("returns capability overrides from matrix plugin metadata", () => {
    expectCapabilities("matrix", ["nestedOnly", "sender", false, true]);
  });

  it("returns hybrid group semantics for zalouser", () => {
    expectCapabilities("zalouser", ["topOnly", "hybrid", false, false]);
  });

  it("preserves empty sender allowlist warnings for msteams hybrid routing", () => {
    expectCapabilities("msteams", ["topOnly", "hybrid", true, true]);
  });

  it("falls back conservatively for unknown external channels", () => {
    expectCapabilities("external-demo", ["topOnly", "sender", true, true]);
  });

  it("falls back conservatively when channel plugin resolution throws", async () => {
    channelPluginMocks.getChannelPlugin.mockImplementation(() => {
      throw new Error("missing generated bundled module");
    });

    expect(await resolveDoctorChannelAccountIds("telegram", {}, [])).toBeUndefined();
  });

  it("resolves account ids through the configured read-only loader when the registry is empty", async () => {
    const resolveAccount = (_cfg: unknown, accountId?: string | null) => ({
      accountId: accountId === "Work" ? "work" : accountId,
    });
    const cfg = { channels: { telegram: { accounts: { default: {}, work: {} } } } };
    const env = { TELEGRAM_BOT_TOKEN: "test-token" };
    readOnlyPluginMocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [
        {
          id: "telegram",
          config: {
            listAccountIds: () => ["default", "Work"],
            resolveAccount,
          },
        },
      ],
    });

    await expect(
      resolveDoctorChannelAccountIds("telegram", cfg, ["default", "Work"], { env }),
    ).resolves.toEqual({
      configured: ["default", "work"],
      runtime: ["default", "work"],
    });
    expect(readOnlyPluginMocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(cfg, {
      env,
      includePersistedAuthState: false,
      includeSetupFallbackPlugins: true,
    });
  });

  it.each([false, true])(
    "resolves account ids through plugin semantics (async: %s)",
    async (asyncResolution) => {
      const resolveAccount = (_cfg: unknown, accountId?: string | null) => ({
        accountId: accountId === "Work" ? "work" : accountId,
      });
      channelPluginMocks.getChannelPlugin.mockReturnValue({
        config: {
          listAccountIds: () => ["default", "Work"],
          resolveAccount: asyncResolution
            ? () => {
                throw new Error("legacy account resolution");
              }
            : resolveAccount,
          ...(asyncResolution
            ? {
                resolveAccountAsync: async (cfg: unknown, accountId?: string | null) =>
                  resolveAccount(cfg, accountId),
              }
            : {}),
        },
      } as never);

      expect(await resolveDoctorChannelAccountIds("signal", {}, ["Work"])).toEqual({
        configured: ["work"],
        runtime: ["default", "work"],
      });
    },
  );
});
