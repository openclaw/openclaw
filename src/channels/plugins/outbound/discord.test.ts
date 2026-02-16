import { describe, expect, it } from "vitest";
import { normalizeDiscordOutboundTarget } from "../normalize/discord.js";

describe("normalizeDiscordOutboundTarget", () => {
  it("normalizes bare numeric IDs to channel: prefix", () => {
    expect(normalizeDiscordOutboundTarget("1470130713209602050")).toEqual({
      ok: true,
      to: "channel:1470130713209602050",
    });
  });

  it("passes through channel: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("channel:123")).toEqual({ ok: true, to: "channel:123" });
  });

  it("passes through user: prefixed targets", () => {
    expect(normalizeDiscordOutboundTarget("user:123")).toEqual({ ok: true, to: "user:123" });
  });

  it("passes through channel name strings", () => {
    expect(normalizeDiscordOutboundTarget("general")).toEqual({ ok: true, to: "general" });
  });

  it("returns error for empty target", () => {
    expect(normalizeDiscordOutboundTarget("").ok).toBe(false);
  });

  it("returns error for undefined target", () => {
    expect(normalizeDiscordOutboundTarget(undefined).ok).toBe(false);
  });

  it("trims whitespace", () => {
    expect(normalizeDiscordOutboundTarget("  123  ")).toEqual({ ok: true, to: "channel:123" });
  });
});
