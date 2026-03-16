import { describe, expect, it } from "vitest";
import { getChannelOnboardingAdapter, listChannelOnboardingAdapters } from "./registry.js";

describe("channel onboarding registry", () => {
  it("exposes built-in onboarding adapters", () => {
    const builtinChannels = ["discord", "imessage", "signal", "slack", "telegram", "whatsapp"];

    for (const channel of builtinChannels) {
      expect(getChannelOnboardingAdapter(channel)).toBeDefined();
    }

    const channels = new Set(listChannelOnboardingAdapters().map((adapter) => adapter.channel));
    for (const channel of builtinChannels) {
      expect(channels.has(channel)).toBe(true);
    }
  });
});
