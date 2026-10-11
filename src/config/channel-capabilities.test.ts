// Covers channel capability config normalization and lookup behavior.
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

  it("falls back to provider capabilities when account capabilities are missing", () => {
    const cfg = {
      channels: {
        telegram: {
          capabilities: ["inlineButtons"],
          accounts: {
            default: {},
          },
        },
      },
    } satisfies Partial<OpenClawConfig>;

    expect(
      resolveChannelCapabilities({
        cfg,
        channel: "telegram",
        accountId: "default",
      }),
    ).toEqual(["inlineButtons"]);
  });

  it("supports msteams capabilities", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "msteams",
          source: "test",
          plugin: createMSTeamsPlugin(),
        },
      ]),
    );
    const cfg = {
      channels: { msteams: { capabilities: [" polls ", ""] } },
    } satisfies Partial<OpenClawConfig>;

    expect(
      resolveChannelCapabilities({
        cfg,
        channel: "msteams",
      }),
    ).toEqual(["polls"]);
  });
});

const createStubPlugin = (id: string): ChannelPlugin =>
  createChannelTestPluginBase({ id, config: { listAccountIds: () => [] } });

const baseRegistry = createTestRegistry([
  { pluginId: "telegram", source: "test", plugin: createStubPlugin("telegram") },
  { pluginId: "slack", source: "test", plugin: createStubPlugin("slack") },
]);

const createMSTeamsPlugin = (): ChannelPlugin => createStubPlugin("msteams");
