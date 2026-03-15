import { describe, expect, it } from "vitest";
import { __test as appRenderTest } from "./app-render.ts";

describe("shouldRenderSharedPageHeader", () => {
  it("renders the shared header for standard non-chat tabs", () => {
    expect(appRenderTest.shouldRenderSharedPageHeader("overview", false)).toBe(true);
    expect(appRenderTest.shouldRenderSharedPageHeader("sessions", false)).toBe(true);
  });

  it("keeps usage on its dedicated in-view header", () => {
    expect(appRenderTest.shouldRenderSharedPageHeader("usage", false)).toBe(false);
  });

  it("skips the shared header for chat and config special cases", () => {
    expect(appRenderTest.shouldRenderSharedPageHeader("chat", true)).toBe(false);
    expect(appRenderTest.shouldRenderSharedPageHeader("config", false)).toBe(false);
  });
});
