import { describe, expect, it } from "vitest";
import { __testing } from "./web-search.js";

const { normalizeBraveUiLang } = __testing;

describe("normalizeBraveUiLang", () => {
  it("maps bare language codes to full Brave locales", () => {
    expect(normalizeBraveUiLang("en")).toBe("en-US");
    expect(normalizeBraveUiLang("de")).toBe("de-DE");
    expect(normalizeBraveUiLang("ja")).toBe("ja-JP");
    expect(normalizeBraveUiLang("zh")).toBe("zh-CN");
  });

  it("is case-insensitive for bare codes", () => {
    expect(normalizeBraveUiLang("EN")).toBe("en-US");
    expect(normalizeBraveUiLang("Fr")).toBe("fr-FR");
  });

  it("passes through full hyphenated locales with normalized case", () => {
    expect(normalizeBraveUiLang("en-US")).toBe("en-US");
    expect(normalizeBraveUiLang("pt-BR")).toBe("pt-BR");
  });

  it("normalizes case of hyphenated locales", () => {
    expect(normalizeBraveUiLang("en-us")).toBe("en-US");
    expect(normalizeBraveUiLang("EN-US")).toBe("en-US");
    expect(normalizeBraveUiLang("PT-br")).toBe("pt-BR");
  });

  it("converts underscore-separated locales to hyphenated form", () => {
    expect(normalizeBraveUiLang("en_US")).toBe("en-US");
    expect(normalizeBraveUiLang("pt_BR")).toBe("pt-BR");
    expect(normalizeBraveUiLang("zh_cn")).toBe("zh-CN");
  });

  it("returns undefined for unknown bare codes", () => {
    expect(normalizeBraveUiLang("xx")).toBeUndefined();
    expect(normalizeBraveUiLang("zzz")).toBeUndefined();
  });

  it("returns undefined for empty/undefined input", () => {
    expect(normalizeBraveUiLang(undefined)).toBeUndefined();
    expect(normalizeBraveUiLang("")).toBeUndefined();
    expect(normalizeBraveUiLang("  ")).toBeUndefined();
  });

  it("trims whitespace", () => {
    expect(normalizeBraveUiLang("  en  ")).toBe("en-US");
    expect(normalizeBraveUiLang(" en-US ")).toBe("en-US");
  });
});
