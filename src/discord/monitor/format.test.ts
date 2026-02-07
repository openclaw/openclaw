import { describe, expect, it } from "vitest";
import {
  resolveDiscordSystemLocation,
  formatDiscordReactionEmoji,
  formatDiscordUserTag,
  resolveTimestampMs,
} from "./format.js";

describe("resolveDiscordSystemLocation", () => {
  it("returns DM for direct messages", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: true,
        isGroupDm: false,
        channelName: "general",
      }),
    ).toBe("DM");
  });

  it("returns Group DM with channel name", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: false,
        isGroupDm: true,
        channelName: "friends",
      }),
    ).toBe("Group DM #friends");
  });

  it("returns guild name with channel", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: false,
        isGroupDm: false,
        guild: { name: "My Server" } as any,
        channelName: "general",
      }),
    ).toBe("My Server #general");
  });

  it("returns channel only when no guild name", () => {
    expect(
      resolveDiscordSystemLocation({
        isDirectMessage: false,
        isGroupDm: false,
        channelName: "general",
      }),
    ).toBe("#general");
  });
});

describe("formatDiscordReactionEmoji", () => {
  it("formats custom emoji with name and id", () => {
    expect(formatDiscordReactionEmoji({ id: "12345", name: "thumbsup" })).toBe("thumbsup:12345");
  });

  it("returns name only for unicode emoji", () => {
    expect(formatDiscordReactionEmoji({ name: "👍" })).toBe("👍");
  });

  it("returns 'emoji' when no name", () => {
    expect(formatDiscordReactionEmoji({})).toBe("emoji");
  });

  it("returns 'emoji' for null name", () => {
    expect(formatDiscordReactionEmoji({ name: null })).toBe("emoji");
  });
});

describe("formatDiscordUserTag", () => {
  it("returns username#discriminator for non-zero discriminator", () => {
    expect(formatDiscordUserTag({ username: "alice", discriminator: "1234" } as any)).toBe(
      "alice#1234",
    );
  });

  it("returns username for discriminator '0'", () => {
    expect(formatDiscordUserTag({ username: "alice", discriminator: "0" } as any)).toBe("alice");
  });

  it("returns username when discriminator is empty", () => {
    expect(formatDiscordUserTag({ username: "alice", discriminator: "" } as any)).toBe("alice");
  });

  it("returns username when no discriminator", () => {
    expect(formatDiscordUserTag({ username: "alice" } as any)).toBe("alice");
  });

  it("falls back to id when no username", () => {
    expect(formatDiscordUserTag({ id: "999" } as any)).toBe("999");
  });
});

describe("resolveTimestampMs", () => {
  it("returns undefined for undefined", () => {
    expect(resolveTimestampMs(undefined)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(resolveTimestampMs(null)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(resolveTimestampMs("")).toBeUndefined();
  });

  it("parses ISO date string", () => {
    expect(resolveTimestampMs("2025-01-15T12:00:00.000Z")).toBe(
      Date.parse("2025-01-15T12:00:00.000Z"),
    );
  });

  it("returns undefined for invalid date", () => {
    expect(resolveTimestampMs("not-a-date")).toBeUndefined();
  });
});
