import { Separator, TextDisplay } from "@buape/carbon";
import { describe, expect, it } from "vitest";
import { DiscordUiContainer } from "../../discord/ui.js";
import { getChannelMessageAdapter } from "./channel-adapters.js";

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
    const container = components?.[0] as DiscordUiContainer | undefined;

    expect(components).toHaveLength(1);
    expect(container).toBeInstanceOf(DiscordUiContainer);
    expect(container?.components).toEqual([
      expect.any(TextDisplay),
      expect.any(Separator),
      expect.any(TextDisplay),
    ]);
  });

  it("omits the message body block when the cross-context message is blank", () => {
    const adapter = getChannelMessageAdapter("discord");
    const components = adapter.buildCrossContextComponents?.({
      originLabel: "Signal",
      message: "   ",
      cfg: {} as never,
    });
    const container = components?.[0] as DiscordUiContainer | undefined;

    expect(components).toHaveLength(1);
    expect(container?.components).toEqual([expect.any(TextDisplay)]);
  });
});
