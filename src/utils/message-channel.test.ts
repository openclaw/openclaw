import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createMSTeamsTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  INTER_SESSION_CHANNEL,
  listReservedChannelIds,
  normalizeMessageChannel,
  resolveGatewayMessageChannel,
} from "./message-channel.js";

const emptyRegistry = createTestRegistry([]);
const msteamsPlugin: ChannelPlugin = {
  ...createMSTeamsTestPluginBase(),
};

describe("message-channel", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("normalizes gateway message channels and rejects unknown values", () => {
    expect(resolveGatewayMessageChannel("discord")).toBe("discord");
    expect(resolveGatewayMessageChannel(" imsg ")).toBe("imessage");
    expect(resolveGatewayMessageChannel("web")).toBeUndefined();
    expect(resolveGatewayMessageChannel("nope")).toBeUndefined();
  });

  it("normalizes plugin aliases when registered", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
    );
    expect(resolveGatewayMessageChannel("teams")).toBe("msteams");
  });

  it("does not remap reserved sentinel ids through mutable plugin aliases", () => {
    const plugin: ChannelPlugin = {
      ...createMSTeamsTestPluginBase(),
      meta: {
        ...createMSTeamsTestPluginBase().meta,
        aliases: ["teams"],
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "msteams", plugin, source: "test" }]));

    plugin.meta.aliases?.push(INTER_SESSION_CHANNEL);

    expect(normalizeMessageChannel(INTER_SESSION_CHANNEL)).toBe(INTER_SESSION_CHANNEL);
  });

  it("ignores non-string plugin aliases during channel normalization", () => {
    const plugin: ChannelPlugin = {
      ...createMSTeamsTestPluginBase(),
      meta: {
        ...createMSTeamsTestPluginBase().meta,
        aliases: ["teams", 42 as never, null as never],
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "msteams", plugin, source: "test" }]));

    expect(resolveGatewayMessageChannel("teams")).toBe("msteams");
    expect(() => normalizeMessageChannel("unknown-channel")).not.toThrow();
    expect(normalizeMessageChannel("unknown-channel")).toBe("unknown-channel");
  });

  it("does not let callers mutate the reserved channel source of truth", () => {
    const reserved = listReservedChannelIds();

    reserved.length = 0;
    reserved.push("discord");

    expect(normalizeMessageChannel(INTER_SESSION_CHANNEL)).toBe(INTER_SESSION_CHANNEL);
    expect(normalizeMessageChannel("webchat")).toBe("webchat");
  });
});
