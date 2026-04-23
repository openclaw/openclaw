import { describe, expect, it } from "vitest";
import { resolveTelegramStreamMode } from "./bot/helpers.js";

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

  it("accepts object-form streaming config", () => {
    expect(resolveTelegramStreamMode({ streaming: { mode: "off" } })).toBe("off");
    expect(resolveTelegramStreamMode({ streaming: { mode: "progress" } })).toBe("partial");
    expect(resolveTelegramStreamMode({ streaming: { mode: true } })).toBe("partial");
  });
});
