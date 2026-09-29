// Outbound send mapping tests cover CLI-to-channel outbound payload mapping.
import { describe, expect, it, vi } from "vitest";
import { createOutboundSendDepsFromCliSource } from "./outbound-send-mapping.js";

describe("createOutboundSendDepsFromCliSource", () => {
  it("adds generic legacy aliases for channel-keyed send deps", () => {
    const deps = {
      telegram: vi.fn(),
      imessage: vi.fn(),
    };

    const outbound = createOutboundSendDepsFromCliSource(deps);

    expect(outbound).toEqual({
      telegram: deps.telegram,
      imessage: deps.imessage,
      sendTelegram: deps.telegram,
      sendImessage: deps.imessage,
    });
  });

  it("preserves explicitly provided Discord voice helper deps", () => {
    const discordVoice = vi.fn();
    const outbound = createOutboundSendDepsFromCliSource({ discordVoice });

    expect(outbound.discordVoice).toBe(discordVoice);
    expect(outbound.sendDiscordVoice).toBe(discordVoice);
  });
});
