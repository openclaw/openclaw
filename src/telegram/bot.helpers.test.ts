import { describe, expect, it } from "vitest";
import {
  resolveTelegramEffectiveReplyToMode,
  resolveTelegramEffectiveStreamMode,
  resolveTelegramStreamMode,
} from "./bot/helpers.js";

describe("resolveTelegramStreamMode", () => {
  it("defaults to partial when telegram streaming is unset", () => {
    expect(resolveTelegramStreamMode(undefined)).toBe("partial");
    expect(resolveTelegramStreamMode({})).toBe("partial");
  });

  it("prefers explicit streaming boolean", () => {
    expect(resolveTelegramStreamMode({ streaming: true })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: false })).toBe("off");
  });

  it("maps legacy streamMode values", () => {
    expect(resolveTelegramStreamMode({ streamMode: "off" })).toBe("off");
    expect(resolveTelegramStreamMode({ streamMode: "partial" })).toBe("partial");
    expect(resolveTelegramStreamMode({ streamMode: "block" })).toBe("block");
  });

  it("maps unified progress mode to partial on Telegram", () => {
    expect(resolveTelegramStreamMode({ streaming: "progress" })).toBe("partial");
  });
});

describe("resolveTelegramEffectiveReplyToMode", () => {
  it("prefers topic over group/direct over account defaults", () => {
    expect(
      resolveTelegramEffectiveReplyToMode(
        { replyToMode: "all" },
        { replyToMode: "first" },
        { replyToMode: "off" },
      ),
    ).toBe("all");
  });

  it("falls back to off when no override is configured", () => {
    expect(resolveTelegramEffectiveReplyToMode(undefined, undefined, undefined)).toBe("off");
  });
});

describe("resolveTelegramEffectiveStreamMode", () => {
  it("prefers topic over group/direct over account defaults", () => {
    expect(
      resolveTelegramEffectiveStreamMode(
        { streaming: "off" },
        { streaming: "block" },
        { streaming: "partial" },
      ),
    ).toBe("off");
  });

  it("supports legacy streamMode overrides in scoped configs", () => {
    expect(resolveTelegramEffectiveStreamMode({ streamMode: "block" }, undefined)).toBe("block");
  });

  it("defaults to partial when no scoped override is configured", () => {
    expect(resolveTelegramEffectiveStreamMode(undefined, undefined, undefined)).toBe("partial");
  });
});
