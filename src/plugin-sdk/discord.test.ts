import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const runtimeConfig = { channels: { discord: { token: "token" } } };
  const apiModule = {
    collectDiscordStatusIssues: vi.fn(() => []),
    discordOnboardingAdapter: { kind: "legacy-onboarding" },
    inspectDiscordAccount: vi.fn(() => ({ accountId: "default" })),
    listDiscordAccountIds: vi.fn(() => ["default"]),
    listDiscordDirectoryGroupsFromConfig: vi.fn(() => []),
    listDiscordDirectoryPeersFromConfig: vi.fn(() => []),
    looksLikeDiscordTargetId: vi.fn(() => true),
    normalizeDiscordMessagingTarget: vi.fn(() => "channel:123"),
    normalizeDiscordOutboundTarget: vi.fn(() => ({ ok: true, to: "channel:123" })),
    resolveDefaultDiscordAccountId: vi.fn(() => "default"),
    resolveDiscordAccount: vi.fn(() => ({
      accountId: "default",
      config: {},
      enabled: true,
      token: "token",
      tokenSource: "config",
    })),
    resolveDiscordGroupRequireMention: vi.fn(() => true),
    resolveDiscordGroupToolPolicy: vi.fn(() => undefined),
  };
  const runtimeModule = {
    autoBindSpawnedDiscordSubagent: vi.fn(async (params) => ({
      accountId: params.accountId ?? "default",
      channelId: "123",
      targetKind: "subagent",
      targetSessionKey: params.childSessionKey,
      threadId: "456",
      cfg: params.cfg,
    })),
    collectDiscordAuditChannelIds: vi.fn(() => ({ channelIds: [], unresolvedChannels: [] })),
    listThreadBindingsBySessionKey: vi.fn(() => []),
    unbindThreadBindingsBySessionKey: vi.fn(() => []),
  };

  return {
    apiModule,
    runtimeModule,
    runtimeConfig,
    loadBundledPluginPublicSurfaceModuleSync: vi.fn((params: { artifactBasename: string }) => {
      if (params.artifactBasename === "runtime-api.js") {
        return runtimeModule;
      }
      return apiModule;
    }),
  };
});

vi.mock("./facade-loader.js", () => ({
  createLazyFacadeObjectValue: (load: () => object) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          return Reflect.get(load(), property);
        },
      },
    ),
  loadBundledPluginPublicSurfaceModuleSync: mocks.loadBundledPluginPublicSurfaceModuleSync,
}));

vi.mock("./runtime-config-snapshot.js", () => ({
  getRuntimeConfig: () => mocks.runtimeConfig,
  getRuntimeConfigSnapshot: () => mocks.runtimeConfig,
}));

describe("discord plugin-sdk compatibility facade", () => {
  it("exports the @openclaw/discord 2026.3.13 import surface", async () => {
    const discordSdk = await import("./discord.js");

    for (const exportName of [
      "DEFAULT_ACCOUNT_ID",
      "DiscordConfigSchema",
      "PAIRING_APPROVED_MESSAGE",
      "applyAccountNameToChannelSection",
      "autoBindSpawnedDiscordSubagent",
      "buildChannelConfigSchema",
      "buildComputedAccountStatusSnapshot",
      "buildTokenChannelStatusSummary",
      "collectDiscordAuditChannelIds",
      "collectDiscordStatusIssues",
      "discordOnboardingAdapter",
      "emptyPluginConfigSchema",
      "getChatChannelMeta",
      "inspectDiscordAccount",
      "listDiscordAccountIds",
      "listDiscordDirectoryGroupsFromConfig",
      "listDiscordDirectoryPeersFromConfig",
      "listThreadBindingsBySessionKey",
      "looksLikeDiscordTargetId",
      "migrateBaseNameToDefaultAccount",
      "normalizeAccountId",
      "normalizeDiscordMessagingTarget",
      "normalizeDiscordOutboundTarget",
      "projectCredentialSnapshotFields",
      "resolveConfiguredFromCredentialStatuses",
      "resolveDefaultDiscordAccountId",
      "resolveDiscordAccount",
      "resolveDiscordGroupRequireMention",
      "resolveDiscordGroupToolPolicy",
      "unbindThreadBindingsBySessionKey",
    ]) {
      expect(discordSdk).toHaveProperty(exportName);
    }
  });

  it("keeps legacy Discord subagent auto-bind calls working without cfg", async () => {
    const { autoBindSpawnedDiscordSubagent } = await import("./discord.js");

    const binding = await autoBindSpawnedDiscordSubagent({
      agentId: "agent",
      channel: "discord",
      childSessionKey: "child",
    });

    expect(mocks.runtimeModule.autoBindSpawnedDiscordSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent",
        cfg: mocks.runtimeConfig,
        childSessionKey: "child",
      }),
    );
    expect(binding).toEqual(
      expect.objectContaining({
        cfg: mocks.runtimeConfig,
        targetKind: "subagent",
        targetSessionKey: "child",
      }),
    );
  });
});
