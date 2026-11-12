/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { loadSettings, saveSettings } from "./settings.ts";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat details rail preference", () => {
  it("persists a remembered Details rail collapsed preference", () => {
    expect(loadSettings().chatDetailsCollapsed).toBeUndefined();
    saveSettings({ ...loadSettings(), chatDetailsCollapsed: true });
    expect(loadSettings().chatDetailsCollapsed).toBe(true);
    saveSettings({ ...loadSettings(), chatDetailsCollapsed: false });
    expect(loadSettings().chatDetailsCollapsed).toBe(false);
    saveSettings({ ...loadSettings(), chatDetailsCollapsed: undefined });
    expect(loadSettings().chatDetailsCollapsed).toBeUndefined();
  });
});
