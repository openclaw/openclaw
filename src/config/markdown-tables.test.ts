import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "./config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveMarkdownTableMode } from "./markdown-tables.js";

const stubPlugin = (id: string): ChannelPlugin => ({
  id,
  meta: {
    id,
    label: id,
    selectionLabel: id,
    docsPath: `/channels/${id}`,
    blurb: "test stub.",
  },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
});

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "mattermost", plugin: stubPlugin("mattermost"), source: "test" },
      { pluginId: "signal", plugin: stubPlugin("signal"), source: "test" },
      { pluginId: "whatsapp", plugin: stubPlugin("whatsapp"), source: "test" },
      { pluginId: "discord", plugin: stubPlugin("discord"), source: "test" },
    ]),
  );
});

describe("resolveMarkdownTableMode", () => {
  it("defaults mattermost to 'off' (native table support)", () => {
    expect(resolveMarkdownTableMode({ channel: "mattermost" })).toBe("off");
  });

  it("defaults signal to 'bullets'", () => {
    expect(resolveMarkdownTableMode({ channel: "signal" })).toBe("bullets");
  });

  it("defaults whatsapp to 'bullets'", () => {
    expect(resolveMarkdownTableMode({ channel: "whatsapp" })).toBe("bullets");
  });

  it("defaults unknown channels to 'code'", () => {
    expect(resolveMarkdownTableMode({ channel: "discord" })).toBe("code");
  });

  it("respects channel-level config override", () => {
    const cfg: Partial<OpenClawConfig> = {
      channels: {
        mattermost: { markdown: { tables: "bullets" } },
      },
    };
    expect(resolveMarkdownTableMode({ cfg, channel: "mattermost" })).toBe("bullets");
  });

  it("respects per-account config override", () => {
    const cfg: Partial<OpenClawConfig> = {
      channels: {
        mattermost: {
          accounts: {
            myaccount: { markdown: { tables: "code" } },
          },
        },
      },
    };
    expect(resolveMarkdownTableMode({ cfg, channel: "mattermost", accountId: "myaccount" })).toBe(
      "code",
    );
  });
});
