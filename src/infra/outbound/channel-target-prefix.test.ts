import { beforeEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  resolveTargetPrefixedChannel,
  stripTargetTopicSuffix,
  validateTargetProviderPrefix,
} from "./channel-target-prefix.js";

beforeEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("stripTargetTopicSuffix", () => {
  it("strips explicit topic suffixes", () => {
    expect(stripTargetTopicSuffix("room-a:topic:77")).toBe("room-a");
  });

  it("strips Telegram numeric topic shorthand only when requested", () => {
    expect(stripTargetTopicSuffix("-100200300:77", { allowNumericShorthand: true })).toBe(
      "-100200300",
    );
  });

  it("keeps generic colon targets intact", () => {
    expect(stripTargetTopicSuffix("room:123")).toBe("room:123");
    expect(stripTargetTopicSuffix("room-a:child")).toBe("room-a:child");
  });
});

describe("resolveTargetPrefixedChannel", () => {
  it("keeps native channel prefixes owned by native plugins when broker aliases overlap", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "channel-broker",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "channel-broker" }),
            messaging: { targetPrefixes: ["broker", "telegram", "discord", "slack"] },
          },
        },
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { targetPrefixes: ["telegram"] },
          },
        },
      ]),
    );

    expect(resolveTargetPrefixedChannel("telegram:123")).toBe("telegram");
    expect(validateTargetProviderPrefix({ channel: "telegram", to: "telegram:123" })).toBe(
      undefined,
    );
    expect(
      validateTargetProviderPrefix({ channel: "channel-broker", to: "telegram:123" }),
    ).toMatchInlineSnapshot(
      `[Error: Target prefix "telegram:" belongs to telegram, not channel-broker.]`,
    );
  });

  it("lets broker aliases own platform prefixes when no native plugin declares them", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "channel-broker",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "channel-broker" }),
            messaging: { targetPrefixes: ["broker", "telegram"] },
          },
        },
      ]),
    );

    expect(resolveTargetPrefixedChannel("telegram:123")).toBe("channel-broker");
  });
});
