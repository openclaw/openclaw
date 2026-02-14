import { describe, expect, it } from "vitest";
import {
  normalizeDiscordSlug,
  normalizeSlackSlug,
  parseTelegramGroupId,
} from "./group-mentions.js";

// ---------------------------------------------------------------------------
// normalizeDiscordSlug
// ---------------------------------------------------------------------------

describe("normalizeDiscordSlug", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeDiscordSlug(null)).toBe("");
    expect(normalizeDiscordSlug(undefined)).toBe("");
    expect(normalizeDiscordSlug("")).toBe("");
    expect(normalizeDiscordSlug("   ")).toBe("");
  });

  it("lowercases input", () => {
    expect(normalizeDiscordSlug("General")).toBe("general");
    expect(normalizeDiscordSlug("MY-CHANNEL")).toBe("my-channel");
  });

  it("strips leading @ and # characters", () => {
    expect(normalizeDiscordSlug("#general")).toBe("general");
    expect(normalizeDiscordSlug("##general")).toBe("general");
    expect(normalizeDiscordSlug("@user")).toBe("user");
  });

  it("converts spaces and underscores to dashes", () => {
    expect(normalizeDiscordSlug("my channel")).toBe("my-channel");
    expect(normalizeDiscordSlug("my_channel")).toBe("my-channel");
    expect(normalizeDiscordSlug("my  channel")).toBe("my-channel");
  });

  it("removes non-alphanumeric characters (except dashes)", () => {
    expect(normalizeDiscordSlug("hello!world")).toBe("hello-world");
    expect(normalizeDiscordSlug("a&b*c")).toBe("a-b-c");
  });

  it("collapses multiple dashes and trims edge dashes", () => {
    expect(normalizeDiscordSlug("--hello--world--")).toBe("hello-world");
    expect(normalizeDiscordSlug("a---b")).toBe("a-b");
  });

  it("handles typical Discord channel names", () => {
    expect(normalizeDiscordSlug("#🎮-gaming-chat")).toBe("gaming-chat");
    expect(normalizeDiscordSlug("dev-ops")).toBe("dev-ops");
  });
});

// ---------------------------------------------------------------------------
// normalizeSlackSlug
// ---------------------------------------------------------------------------

describe("normalizeSlackSlug", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeSlackSlug(null)).toBe("");
    expect(normalizeSlackSlug(undefined)).toBe("");
    expect(normalizeSlackSlug("")).toBe("");
    expect(normalizeSlackSlug("   ")).toBe("");
  });

  it("lowercases input", () => {
    expect(normalizeSlackSlug("General")).toBe("general");
  });

  it("converts spaces to dashes", () => {
    expect(normalizeSlackSlug("my channel")).toBe("my-channel");
    expect(normalizeSlackSlug("a  b")).toBe("a-b");
  });

  it("preserves Slack-valid chars: #, @, ., +, _", () => {
    expect(normalizeSlackSlug("#general")).toBe("#general");
    expect(normalizeSlackSlug("@user")).toBe("@user");
    expect(normalizeSlackSlug("dev.ops")).toBe("dev.ops");
    expect(normalizeSlackSlug("c++")).toBe("c++");
    expect(normalizeSlackSlug("my_channel")).toBe("my_channel");
  });

  it("removes invalid characters", () => {
    expect(normalizeSlackSlug("hello!world")).toBe("hello-world");
    expect(normalizeSlackSlug("a&b")).toBe("a-b");
  });

  it("collapses multiple dashes and trims edge dashes/dots", () => {
    expect(normalizeSlackSlug("--hello--")).toBe("hello");
    expect(normalizeSlackSlug("..hello..")).toBe("hello");
    expect(normalizeSlackSlug("-.hello.-")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// parseTelegramGroupId
// ---------------------------------------------------------------------------

describe("parseTelegramGroupId", () => {
  it("returns undefined chatId/topicId for null/undefined/empty", () => {
    expect(parseTelegramGroupId(null)).toEqual({ chatId: undefined, topicId: undefined });
    expect(parseTelegramGroupId(undefined)).toEqual({ chatId: undefined, topicId: undefined });
    expect(parseTelegramGroupId("")).toEqual({ chatId: undefined, topicId: undefined });
    expect(parseTelegramGroupId("   ")).toEqual({ chatId: undefined, topicId: undefined });
  });

  it("parses plain chat ID (no topic)", () => {
    expect(parseTelegramGroupId("-1001234567890")).toEqual({
      chatId: "-1001234567890",
      topicId: undefined,
    });
  });

  it("parses chatId:topicId format", () => {
    expect(parseTelegramGroupId("-100123:456")).toEqual({
      chatId: "-100123",
      topicId: "456",
    });
  });

  it("parses chatId:topic:topicId format", () => {
    expect(parseTelegramGroupId("-100123:topic:789")).toEqual({
      chatId: "-100123",
      topicId: "789",
    });
  });

  it("prefers :topic: format over plain two-part", () => {
    // When three+ parts with :topic: marker, uses that parser branch
    expect(parseTelegramGroupId("-100123:topic:42")).toEqual({
      chatId: "-100123",
      topicId: "42",
    });
  });

  it("returns raw as chatId for non-numeric input", () => {
    expect(parseTelegramGroupId("my-group")).toEqual({
      chatId: "my-group",
      topicId: undefined,
    });
  });

  it("handles positive chat IDs", () => {
    expect(parseTelegramGroupId("12345")).toEqual({
      chatId: "12345",
      topicId: undefined,
    });
  });

  it("handles positive chatId:topicId", () => {
    expect(parseTelegramGroupId("12345:99")).toEqual({
      chatId: "12345",
      topicId: "99",
    });
  });
});
