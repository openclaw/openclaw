import { describe, expect, it } from "vitest";
import { sessionBindingContractChannelIds } from "./manifest.js";

const discordSessionBindingAdapterChannels = ["discord"] as const;

describe("channel contract registry", () => {
  it("keeps core session binding coverage aligned with built-in adapters", () => {
    expect([...sessionBindingContractChannelIds]).toEqual(
      expect.arrayContaining([...discordSessionBindingAdapterChannels, "telegram"]),
    );
  });
});
