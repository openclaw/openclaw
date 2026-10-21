import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyConfigRule } from "../../config/legacy.shared.js";

const {
  loadBundledChannelDoctorContractApiMock,
  getBootstrapChannelPluginMock,
  listPluginDoctorLegacyConfigRulesMock,
} = vi.hoisted(() => ({
  loadBundledChannelDoctorContractApiMock: vi.fn(),
  getBootstrapChannelPluginMock: vi.fn(),
  listPluginDoctorLegacyConfigRulesMock: vi.fn((): LegacyConfigRule[] => []),
}));

vi.mock("./doctor-contract-api.js", () => ({
  loadBundledChannelDoctorContractApi: loadBundledChannelDoctorContractApiMock,
}));

vi.mock("./bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: getBootstrapChannelPluginMock,
}));

vi.mock("../../plugins/doctor-contract-registry.js", () => ({
  listPluginDoctorLegacyConfigRules: listPluginDoctorLegacyConfigRulesMock,
}));

import { collectChannelLegacyConfigRules } from "./legacy-config.js";

const legacyRule = (channel: string, leaf?: string): LegacyConfigRule => ({
  path: ["channels", channel, ...(leaf ? [leaf] : [])],
  message: `legacy ${channel === "custom-chat" ? "custom" : channel} rule`,
});
const configuredChannels = { channels: { discord: {}, telegram: {} } };

describe("collectChannelLegacyConfigRules", () => {
  beforeEach(() => {
    loadBundledChannelDoctorContractApiMock.mockReset();
    getBootstrapChannelPluginMock.mockReset();
    listPluginDoctorLegacyConfigRulesMock.mockReset();
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([]);
  });

  it("falls back to bootstrap rules and only scans unresolved channels", () => {
    getBootstrapChannelPluginMock.mockImplementation((channelId: string) =>
      channelId === "slack"
        ? {
            doctor: {
              legacyConfigRules: [legacyRule("slack", "legacy")],
            },
          }
        : undefined,
    );
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([legacyRule("custom-chat", "legacy")]);

    const config = { channels: { slack: {}, "custom-chat": {} } };
    const rules = collectChannelLegacyConfigRules(config);

    expect(rules).toEqual([legacyRule("slack", "legacy"), legacyRule("custom-chat", "legacy")]);
    expect(listPluginDoctorLegacyConfigRulesMock).toHaveBeenCalledWith({
      config,
      pluginIds: ["custom-chat"],
    });
  });

  it("does not rescan registry when a bundled bootstrap plugin has no legacy rules", () => {
    getBootstrapChannelPluginMock.mockImplementation((channelId: string) =>
      channelId === "imessage" ? { doctor: {} } : undefined,
    );

    const rules = collectChannelLegacyConfigRules({ channels: { imessage: {} } });

    expect(rules).toStrictEqual([]);
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("scopes channel legacy scans to touched channels during dry-run validation", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) => ({
      legacyConfigRules: [legacyRule(channelId)],
    }));

    const rules = collectChannelLegacyConfigRules(configuredChannels, [
      ["channels", "discord", "token"],
    ]);

    expect(rules).toEqual([legacyRule("discord")]);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledTimes(1);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledWith("discord");
  });

  it("skips channel ids already covered by explicit legacy rules", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) => ({
      legacyConfigRules: [legacyRule(channelId)],
    }));

    const rules = collectChannelLegacyConfigRules(
      configuredChannels,
      undefined,
      new Set(["telegram"]),
    );

    expect(rules).toEqual([legacyRule("discord")]);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledTimes(1);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledWith("discord");
  });
});
