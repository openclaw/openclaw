import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../../../extensions/discord/src/channel.js";
import { importFreshModule } from "../../../test/helpers/import-fresh.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

let importScope = 0;
let getChannelMessageAdapter: (typeof import("./channel-adapters.js"))["getChannelMessageAdapter"];

beforeEach(async () => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
  vi.resetModules();
  const scope = `channel-adapters-${importScope++}`;
  ({ getChannelMessageAdapter } = await importFreshModule<typeof import("./channel-adapters.js")>(
    import.meta.url,
    `./channel-adapters.js?scope=${scope}`,
  ));
});

describe("getChannelMessageAdapter", () => {
  it("returns the default adapter for non-discord channels", () => {
    expect(getChannelMessageAdapter("telegram")).toEqual({
      supportsComponentsV2: false,
    });
  });

  it("returns the discord adapter with a cross-context component builder", () => {
    const adapter = getChannelMessageAdapter("discord");

    expect(adapter.supportsComponentsV2).toBe(true);
    expect(adapter.buildCrossContextComponents).toBeTypeOf("function");

    const components = adapter.buildCrossContextComponents?.({
      originLabel: "Telegram",
      message: "Hello from chat",
      cfg: {} as never,
      accountId: "primary",
    });
    const container = components?.[0] as
      | { components: Array<{ constructor: { name: string } }> }
      | undefined;

    expect(components).toHaveLength(1);
    expect(container?.constructor.name).toBe("DiscordUiContainer");
    expect(container?.components.map((component) => component.constructor.name)).toEqual([
      "TextDisplay",
      "Separator",
      "TextDisplay",
    ]);
  });

  it("omits the message body block when the cross-context message is blank", () => {
    const adapter = getChannelMessageAdapter("discord");
    const components = adapter.buildCrossContextComponents?.({
      originLabel: "Signal",
      message: "   ",
      cfg: {} as never,
    });
    const container = components?.[0] as
      | { components: Array<{ constructor: { name: string } }> }
      | undefined;

    expect(components).toHaveLength(1);
    expect(container?.components.map((component) => component.constructor.name)).toEqual([
      "TextDisplay",
    ]);
  });
});
