import { describe, expect, it } from "vitest";
import { getChannelMessageAdapter } from "./channel-adapters.js";

describe("getChannelMessageAdapter", () => {
  it("returns discord adapter with embed support", () => {
    const adapter = getChannelMessageAdapter("discord");
    expect(adapter.supportsEmbeds).toBe(true);
    expect(adapter.buildCrossContextEmbeds).toBeDefined();
  });

  it("discord adapter builds cross-context embeds", () => {
    const adapter = getChannelMessageAdapter("discord");
    const embeds = adapter.buildCrossContextEmbeds!("TG #general");
    expect(embeds).toEqual([{ description: "From TG #general" }]);
  });

  it("returns default adapter for telegram", () => {
    const adapter = getChannelMessageAdapter("telegram");
    expect(adapter.supportsEmbeds).toBe(false);
    expect(adapter.buildCrossContextEmbeds).toBeUndefined();
  });

  it("returns default adapter for line", () => {
    const adapter = getChannelMessageAdapter("line");
    expect(adapter.supportsEmbeds).toBe(false);
  });

  it("returns default adapter for whatsapp", () => {
    const adapter = getChannelMessageAdapter("whatsapp");
    expect(adapter.supportsEmbeds).toBe(false);
  });

  it("returns default adapter for unknown channel", () => {
    const adapter = getChannelMessageAdapter("unknown" as any);
    expect(adapter.supportsEmbeds).toBe(false);
  });
});
