import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../../channels/plugins/types.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { resolveQueueSettings } from "./settings.js";

describe("resolveQueueSettings (plugin defaults)", () => {
  const emptyRegistry = createTestRegistry([]);

  const createPlugin = (id: string): ChannelPlugin => ({
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    defaults: { queue: { mode: "followup", debounceMs: 123 } },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
    },
  });

  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("uses plugin default mode/debounce when config is unset", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "zulip", plugin: createPlugin("zulip"), source: "test" }]),
    );

    const settings = resolveQueueSettings({ cfg: {}, channel: "zulip" });
    expect(settings.mode).toBe("followup");
    expect(settings.debounceMs).toBe(123);
  });

  it("prefers config mode over plugin default", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "zulip", plugin: createPlugin("zulip"), source: "test" }]),
    );

    const settings = resolveQueueSettings({
      cfg: { messages: { queue: { mode: "collect" } } },
      channel: "zulip",
    });
    expect(settings.mode).toBe("collect");
  });
});
