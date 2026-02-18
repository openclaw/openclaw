import { describe, expect, it } from "vitest";
import { isNumericTelegramUserId, normalizeTelegramAllowFromEntry } from "./allow-from.js";

describe("telegram allow-from helpers", () => {
  it("normalizes tg/telegram prefixes", () => {
    expect(normalizeTelegramAllowFromEntry(" TG:123 ")).toBe("123");
    expect(normalizeTelegramAllowFromEntry("telegram:@someone")).toBe("@someone");
  });

  it("accepts signed numeric IDs", () => {
    expect(isNumericTelegramUserId("123456789")).toBe(true);
    expect(isNumericTelegramUserId("-1001234567890")).toBe(true);
    expect(isNumericTelegramUserId("@someone")).toBe(false);
    expect(isNumericTelegramUserId("12 34")).toBe(false);
  });
});
