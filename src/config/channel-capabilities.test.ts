import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveChannelCapabilities } from "./channel-capabilities.js";
import type { OpenClawConfig } from "./config.js";

describe("resolveChannelCapabilities", () => {
  beforeEach(() => {
    setActivePluginRegistry(baseRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(baseRegistry);
  });

  it("returns undefined for missing inputs", () => {
    expect(resolveChannelCapabilities({})).toBeUndefined();
    expect(resolveChannelCapabilities({ cfg: {} })).toBeUndefined();
    expect(resolveChannelCapabilities({ cfg: {}, channel: "" })).toBeUndefined();
  });

  it.each<
    [
      string,
      "telegram" | "slack",
      string,
      NonNullable<OpenClawConfig["channels"]>["telegram"],
      string[],
    ]
  >([
    [
      "normalizes account overrides",
      "telegram",
      "default",
      {
        capabilities: [" inlineButtons ", ""],
        accounts: { default: { capabilities: [" perAccount ", "  "] } },
      },
      ["perAccount"],
    ],
    [
      "falls back to channel capabilities",
      "telegram",
      "default",
      {
        capabilities: ["inlineButtons"],
        accounts: { default: {} },
      },
      ["inlineButtons"],
    ],
    [
      "matches account keys case-insensitively",
      "slack",
      "family",
      {
        accounts: { Family: { capabilities: ["threads"] } },
      },
      ["threads"],
    ],
  ])("%s", (_name, channel, accountId, settings, expected) => {
    const cfg = { channels: { [channel]: settings } };
    expect(resolveChannelCapabilities({ cfg, channel, accountId })).toEqual(expected);
  });

  it("supports msteams capabilities", () => {
    setActivePluginRegistry(createTestRegistry([registryEntry("msteams")]));
    const cfg = { channels: { msteams: { capabilities: [" polls ", ""] } } };
    expect(resolveChannelCapabilities({ cfg, channel: "msteams" })).toEqual(["polls"]);
  });

  it("handles object-format capabilities gracefully (e.g., { inlineButtons: 'dm' })", () => {
    const cfg = {
      channels: {
        telegram: {
          capabilities: { inlineButtons: "dm" },
        },
      },
    } as unknown as Partial<OpenClawConfig>;

    expect(resolveChannelCapabilities({ cfg, channel: "telegram" })).toBeUndefined();
  });
});

const registryEntry = (id: string) => ({
  pluginId: id,
  source: "test",
  plugin: createChannelTestPluginBase({
    id,
    config: { listAccountIds: () => [] },
  }) satisfies ChannelPlugin,
});
const baseRegistry = createTestRegistry(["telegram", "slack"].map(registryEntry));
