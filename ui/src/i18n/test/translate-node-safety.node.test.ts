import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

describe("i18n node-mode safety", () => {
  const origLocalStorage = globalThis.localStorage;
  const origNavigator = globalThis.navigator;

  afterAll(() => {
    Object.defineProperty(globalThis, "localStorage", { value: origLocalStorage, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: origNavigator, configurable: true });
  });

  it("does not throw when localStorage and navigator are missing", async () => {
    Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });

    vi.resetModules();
    const { i18n } = await import("../lib/translate.ts");
    expect(i18n.getLocale()).toBe("en");
  });

  it("does not throw when localStorage exists but getItem is missing", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      value: { length: 0 }, // no getItem/setItem
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });

    vi.resetModules();
    const { i18n } = await import("../lib/translate.ts");
    expect(i18n.getLocale()).toBe("en");
  });
});
