import { describe, expect, it } from "vitest";
import {
  validateControlUiI18nGenerateParams,
  validateControlUiI18nGetParams,
  validateControlUiI18nListParams,
} from "./index.js";

describe("controlui.i18n validators", () => {
  it("accepts valid list/get/generate params", () => {
    expect(validateControlUiI18nListParams({})).toBe(true);
    expect(validateControlUiI18nGetParams({ locale: "uk" })).toBe(true);
    expect(validateControlUiI18nGetParams({ locale: "uk-UA" })).toBe(true);
    expect(validateControlUiI18nGenerateParams({ locale: "uk-UA" })).toBe(true);
    expect(validateControlUiI18nGenerateParams({ locale: "pt-BR", force: true })).toBe(true);
  });

  it("rejects unexpected properties", () => {
    expect(validateControlUiI18nListParams({ extra: true })).toBe(false);
    expect(validateControlUiI18nGetParams({ locale: "uk", extra: true })).toBe(false);
    expect(validateControlUiI18nGenerateParams({ locale: "uk", extra: true })).toBe(false);
  });

  it("rejects path-like or invalid locale values", () => {
    expect(validateControlUiI18nGetParams({ locale: "../x" })).toBe(false);
    expect(validateControlUiI18nGetParams({ locale: "nested/x" })).toBe(false);
    expect(validateControlUiI18nGenerateParams({ locale: "nested\\x" })).toBe(false);
    expect(validateControlUiI18nGenerateParams({ locale: "" })).toBe(false);
    expect(validateControlUiI18nGenerateParams({ locale: "a".repeat(65) })).toBe(false);
    expect(validateControlUiI18nGenerateParams({ locale: "uk ua" })).toBe(false);
  });
});
