import { describe, expect, it } from "vitest";
import {
  clearHomeTabCustom,
  hasCurrentHomeTab,
  hasCustomHomeTab,
  markHomeTabCustom,
  markHomeTabPublished,
} from "./home-tab-state.js";

describe("home-tab-state", () => {
  it("markHomeTabCustom → hasCustomHomeTab returns true", () => {
    markHomeTabCustom("U_CUSTOM_1");
    expect(hasCustomHomeTab("U_CUSTOM_1")).toBe(true);
  });

  it("clearHomeTabCustom removes custom flag", () => {
    markHomeTabCustom("U_CUSTOM_2");
    clearHomeTabCustom("U_CUSTOM_2");
    expect(hasCustomHomeTab("U_CUSTOM_2")).toBe(false);
  });

  it("markHomeTabCustom clears published version cache", () => {
    markHomeTabPublished("U_CUSTOM_3", "1.0.0");
    expect(hasCurrentHomeTab("U_CUSTOM_3", "1.0.0")).toBe(true);
    markHomeTabCustom("U_CUSTOM_3");
    expect(hasCurrentHomeTab("U_CUSTOM_3", "1.0.0")).toBe(false);
  });

  it("markHomeTabPublished / hasCurrentHomeTab roundtrip", () => {
    markHomeTabPublished("U_PUB_1", "2.0.0");
    expect(hasCurrentHomeTab("U_PUB_1", "2.0.0")).toBe(true);
    expect(hasCurrentHomeTab("U_PUB_1", "3.0.0")).toBe(false);
  });

  it("hasCustomHomeTab returns false for unknown users", () => {
    expect(hasCustomHomeTab("U_UNKNOWN")).toBe(false);
  });
});
