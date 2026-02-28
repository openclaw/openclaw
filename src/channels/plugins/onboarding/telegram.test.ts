import { describe, expect, it } from "vitest";
import { normalizeTelegramAllowFromInput, parseTelegramAllowFromId } from "./telegram.js";

describe("normalizeTelegramAllowFromInput", () => {
  it("strips telegram/tg prefixes and trims whitespace", () => {
    expect(normalizeTelegramAllowFromInput(" telegram:123 ")).toBe("123");
    expect(normalizeTelegramAllowFromInput("tg:@alice")).toBe("@alice");
    expect(normalizeTelegramAllowFromInput("  @bob  ")).toBe("@bob");
  });
});

describe("parseTelegramAllowFromId", () => {
  it("accepts numeric ids with optional prefixes", () => {
    expect(parseTelegramAllowFromId("12345")).toBe("12345");
    expect(parseTelegramAllowFromId("telegram:98765")).toBe("98765");
    expect(parseTelegramAllowFromId("tg:2468")).toBe("2468");
  });

  it("rejects non-numeric values", () => {
    expect(parseTelegramAllowFromId("@alice")).toBeNull();
    expect(parseTelegramAllowFromId("tg:alice")).toBeNull();
  });
});
