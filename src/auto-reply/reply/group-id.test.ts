// Tests group id derivation for channel sessions and persisted routes.
import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { extractExplicitGroupId } from "./group-id.js";

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
});

describe("extractExplicitGroupId simple targets", () => {
  it("returns undefined for empty/null input", () => {
    expect(extractExplicitGroupId(undefined)).toBeUndefined();
    expect(extractExplicitGroupId(null)).toBeUndefined();
    expect(extractExplicitGroupId("")).toBeUndefined();
    expect(extractExplicitGroupId("  ")).toBeUndefined();
  });

  it("extracts group ID from provider topic format, stripping topic suffix", () => {
    expect(extractExplicitGroupId("chat:group:-1003776849159:topic:1264")).toBe("-1003776849159");
  });

  it("extracts group ID from channel format", () => {
    expect(extractExplicitGroupId("chat:channel:-1001234567890")).toBe("-1001234567890");
  });

  it("extracts group ID from bare group: prefix with topic", () => {
    expect(extractExplicitGroupId("group:-1003776849159:topic:999")).toBe("-1003776849159");
  });

  it("returns undefined for unrecognized formats", () => {
    expect(extractExplicitGroupId("user:12345")).toBeUndefined();
    expect(extractExplicitGroupId("just-a-string")).toBeUndefined();
  });
});

describe("extractExplicitGroupId", () => {
  it.each([
    {
      name: "declared inferred shorthand",
      channel: "telegram",
      declaresNumericShorthand: true,
      expected: "-100200300",
    },
    {
      name: "undeclared inferred shorthand",
      channel: "plainchat",
      declaresNumericShorthand: false,
      expected: "-100200300:77",
    },
  ])(
    "uses $name metadata after target normalization",
    ({ channel, declaresNumericShorthand, expected }) => {
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: channel,
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({
                id: channel,
                capabilities: { chatTypes: ["group"] },
              }),
              messaging: {
                ...(declaresNumericShorthand ? { numericTopicShorthand: true as const } : {}),
                normalizeTarget: () => `${channel}:-100200300:77`,
                inferTargetChatType: () => "group" as const,
              },
            },
          },
        ]),
      );

      expect(extractExplicitGroupId(`${channel}:-100200300:77`)).toBe(expected);
    },
  );
});
