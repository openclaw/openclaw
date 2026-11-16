import { describe, expect, it } from "vitest";
import { isSupportedLocale, resolveNavigatorLocale } from "./control-ui-locale.js";

describe("resolveNavigatorLocale", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["ZH-hAnT-CN", "zh-TW"],
    ["ZH-hAnS-hK", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hans-Hant-CN", "zh-TW"],
    ["zh-Hant-Hans-HK", "zh-TW"],
    ["pt-PT", "pt-BR"],
    ["DE-at", "de"],
    ["ja-JP", "ja-JP"],
    ["ca", "ca"],
    ["ca-ES", "ca"],
    ["sv-SE", "sv"],
    ["sv-FI", "sv"],
    ["nb-NO", "en"],
    ["", "en"],
  ] as const)("maps browser language %s to %s", (browserLanguage, expectedLocale) => {
    expect(resolveNavigatorLocale(browserLanguage)).toBe(expectedLocale);
  });
});

it("accepts only exact supported explicit preferences", () => {
  expect(isSupportedLocale("pt-BR")).toBe(true);
  expect(isSupportedLocale("pt-PT")).toBe(false);
  expect(isSupportedLocale("ZH-CN")).toBe(false);
  expect(isSupportedLocale(null)).toBe(false);
});
