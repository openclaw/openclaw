// Legacy config tests cover channel plugin config compatibility and migration helpers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findLegacyConfigIssues } from "../../config/legacy.js";
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

describe("collectChannelLegacyConfigRules", () => {
  beforeEach(() => {
    loadBundledChannelDoctorContractApiMock.mockReset();
    getBootstrapChannelPluginMock.mockReset();
    listPluginDoctorLegacyConfigRulesMock.mockReset();
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([]);
  });

  it("uses bundled doctor contract rules before falling back to registry scans", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) =>
      channelId === "discord"
        ? {
            legacyConfigRules: [
              {
                path: ["channels", "discord", "voice", "tts"],
                message: "legacy discord rule",
              },
            ],
          }
        : undefined,
    );

    const rules = collectChannelLegacyConfigRules({
      channels: {
        discord: {},
      },
    });

    expect(rules).toEqual([
      {
        path: ["channels", "discord", "voice", "tts"],
        message: "legacy discord rule",
      },
    ]);
    expect(getBootstrapChannelPluginMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("falls back to bootstrap rules and only scans unresolved channels", () => {
    getBootstrapChannelPluginMock.mockImplementation((channelId: string) =>
      channelId === "slack"
        ? {
            doctor: {
              legacyConfigRules: [
                {
                  path: ["channels", "slack", "legacy"],
                  message: "legacy slack rule",
                },
              ],
            },
          }
        : undefined,
    );
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([
      {
        path: ["channels", "custom-chat", "legacy"],
        message: "legacy custom rule",
      },
    ]);

    const config = {
      channels: {
        slack: {},
        "custom-chat": {},
      },
    };
    const rules = collectChannelLegacyConfigRules(config);

    expect(rules).toEqual([
      {
        path: ["channels", "slack", "legacy"],
        message: "legacy slack rule",
      },
      {
        path: ["channels", "custom-chat", "legacy"],
        message: "legacy custom rule",
      },
    ]);
    expect(listPluginDoctorLegacyConfigRulesMock).toHaveBeenCalledWith({
      config,
      pluginIds: ["custom-chat"],
    });
  });

  it("does not rescan registry when a bundled bootstrap plugin has no legacy rules", () => {
    getBootstrapChannelPluginMock.mockImplementation((channelId: string) =>
      channelId === "imessage"
        ? {
            doctor: {},
          }
        : undefined,
    );

    const rules = collectChannelLegacyConfigRules({
      channels: {
        imessage: {},
      },
    });

    expect(rules).toStrictEqual([]);
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("treats empty doctor-contract legacy rules as authoritative", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) =>
      channelId === "imessage" ? { legacyConfigRules: [] } : undefined,
    );
    getBootstrapChannelPluginMock.mockImplementation((channelId: string) =>
      channelId === "imessage"
        ? {
            doctor: {
              legacyConfigRules: [
                {
                  path: ["channels", "imessage", "legacy"],
                  message: "should not load bootstrap rules",
                },
              ],
            },
          }
        : undefined,
    );

    const rules = collectChannelLegacyConfigRules({
      channels: {
        imessage: {},
      },
    });

    expect(rules).toStrictEqual([]);
    expect(getBootstrapChannelPluginMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("scopes channel legacy scans to touched channels during dry-run validation", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) => ({
      legacyConfigRules: [
        {
          path: ["channels", channelId],
          message: `legacy ${channelId} rule`,
        },
      ],
    }));

    const rules = collectChannelLegacyConfigRules(
      {
        channels: {
          discord: {},
          telegram: {},
        },
      },
      [["channels", "discord", "token"]],
    );

    expect(rules).toEqual([
      {
        path: ["channels", "discord"],
        message: "legacy discord rule",
      },
    ]);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledTimes(1);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledWith("discord");
  });

  it("skips channel ids already covered by explicit legacy rules", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) => ({
      legacyConfigRules: [
        {
          path: ["channels", channelId],
          message: `legacy ${channelId} rule`,
        },
      ],
    }));

    const rules = collectChannelLegacyConfigRules(
      {
        channels: {
          discord: {},
          telegram: {},
        },
      },
      undefined,
      new Set(["telegram"]),
    );

    expect(rules).toEqual([
      {
        path: ["channels", "discord"],
        message: "legacy discord rule",
      },
    ]);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledTimes(1);
    expect(loadBundledChannelDoctorContractApiMock).toHaveBeenCalledWith("discord");
  });

  it("skips unreadable bundled doctor contract rule rows", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) => {
      if (channelId !== "discord") {
        return undefined;
      }
      return {
        legacyConfigRules: [
          {
            get path() {
              throw new Error("bundled legacy rule path exploded");
            },
            message: "bad bundled rule",
          },
          {
            path: ["channels", "discord", "healthy"],
            message: "healthy bundled rule",
          },
        ],
      };
    });

    const rules = collectChannelLegacyConfigRules({
      channels: {
        discord: {},
      },
    });

    expect(rules).toEqual([
      {
        path: ["channels", "discord", "healthy"],
        message: "healthy bundled rule",
      },
    ]);
  });

  it("skips unreadable bootstrap doctor rule metadata before healthy rules", () => {
    getBootstrapChannelPluginMock.mockImplementation((channelId: string) =>
      channelId === "matrix"
        ? {
            doctor: {
              get legacyConfigRules() {
                throw new Error("bootstrap legacy rules exploded");
              },
            },
          }
        : channelId === "slack"
          ? {
              doctor: {
                legacyConfigRules: [
                  {
                    path: ["channels", "slack", "legacy"],
                    message: "healthy slack rule",
                  },
                ],
              },
            }
          : undefined,
    );

    const rules = collectChannelLegacyConfigRules({
      channels: {
        matrix: {},
        slack: {},
      },
    });

    expect(rules).toEqual([
      {
        path: ["channels", "slack", "legacy"],
        message: "healthy slack rule",
      },
    ]);
  });

  it("treats throwing plugin rule matchers as non-matches", () => {
    loadBundledChannelDoctorContractApiMock.mockImplementation((channelId: string) =>
      channelId === "discord"
        ? {
            legacyConfigRules: [
              {
                path: ["channels", "discord", "legacy"],
                message: "bad match rule",
                match: () => {
                  throw new Error("legacy rule match exploded");
                },
              },
              {
                path: ["channels", "discord", "healthy"],
                message: "healthy match rule",
              },
            ],
          }
        : undefined,
    );

    const cfg = {
      channels: {
        discord: {
          healthy: true,
          legacy: true,
        },
      },
    };
    const rules = collectChannelLegacyConfigRules(cfg);

    expect(findLegacyConfigIssues(cfg, undefined, rules)).toEqual([
      {
        path: "channels.discord.healthy",
        message: "healthy match rule",
      },
    ]);
  });
});
