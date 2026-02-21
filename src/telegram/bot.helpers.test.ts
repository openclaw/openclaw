import { describe, expect, it } from "vitest";
import { resolveTelegramStreamMode } from "./bot/helpers.js";

describe("resolveTelegramStreamMode", () => {
  it("defaults to off when telegram streaming is unset", () => {
    expect(resolveTelegramStreamMode(undefined)).toBe("off");
    expect(resolveTelegramStreamMode({})).toBe("off");
  });

  it("prefers explicit streaming boolean", () => {
    expect(resolveTelegramStreamMode({ streaming: true })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: false })).toBe("off");
  });

  it("maps legacy streamMode values", () => {
    expect(resolveTelegramStreamMode({ streamMode: "off" })).toBe("off");
    expect(resolveTelegramStreamMode({ streamMode: "partial" })).toBe("partial");
    expect(resolveTelegramStreamMode({ streamMode: "block" })).toBe("partial");
  });
});
