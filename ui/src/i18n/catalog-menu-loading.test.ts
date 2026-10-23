import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  dropRepoOwnedCustomElements,
  trackCustomElementRegistry,
} from "../../../test/jsdom-custom-elements.ts";

const elements = trackCustomElementRegistry(customElements);
let en: (typeof import("./locales/en.ts"))["en"];
let registerCatalogMenuEnglish: (typeof import("./locales/en-catalog-menu.ts"))["registerCatalogMenuEnglish"];
let createI18nManagerForTesting: (typeof import("./lib/translate.test-support.ts"))["createI18nManagerForTesting"];
let restoreI18n: () => Promise<void>;
const menuKeys = [
  "sessionMenu",
  "openInOpenClaw",
  "importToOpenClaw",
  "importComplete",
  "importUnchanged",
  "importIncomplete",
  "openImportedSession",
  "openInTerminal",
  "deleteSession",
  "deleteSessionConfirm",
  "terminalUnavailable",
] as const;

beforeEach(async () => {
  // Each consumer needs its own registrar lifetime: production registers once,
  // so deleting keys cannot replay a registrar already admitted by its WeakSet.
  vi.resetModules();
  const support = await import("./lib/translate.test-support.ts");
  ({ en } = await import("./locales/en.ts"));
  ({ registerCatalogMenuEnglish } = await import("./locales/en-catalog-menu.ts"));
  createI18nManagerForTesting = support.createI18nManagerForTesting;
  restoreI18n = support.captureI18nStateForTesting();
  for (const key of menuKeys) {
    Reflect.deleteProperty(en.chat.catalog, key);
  }
});
afterEach(async () => {
  registerCatalogMenuEnglish();
  await restoreI18n();
  if (elements) {
    dropRepoOwnedCustomElements(elements);
  }
});

it.each([
  {
    surface: "standalone menu",
    load: () => import("../components/catalog-session-menu-solid.tsx"),
  },
  {
    surface: "sidebar menu",
    load: () => import("../components/app-sidebar-catalog-menu-view.tsx"),
  },
])(
  "loads fallback copy with the $surface without replacing active translations",
  async ({ load }) => {
    const manager = createI18nManagerForTesting(async () => ({
      chat: { catalog: { sessionMenu: "Sitzungsaktionen" } },
    }));
    const catalog = en.chat.catalog;
    for (const key of menuKeys) {
      expect(Reflect.has(catalog, key)).toBe(false);
    }
    expect(manager.t("chat.catalog.openOriginal")).toBe("Open original");
    expect(manager.t("chat.catalog.remoteViewOnly")).toBe(
      "This session is on a paired device and is view-only.",
    );
    expect(manager.t("chat.catalog.unsupportedViewOnly")).toBe(
      "This external session source is view-only.",
    );
    await manager.setLocale("de");
    expect(manager.t("chat.catalog.openInOpenClaw")).toBe("chat.catalog.openInOpenClaw");

    await load();

    expect(en.chat.catalog).toBe(catalog);
    for (const key of menuKeys) {
      expect(Reflect.get(catalog, key)).toEqual(expect.any(String));
    }
    expect(manager.t("chat.catalog.sessionMenu")).toBe("Sitzungsaktionen");
    expect(manager.t("chat.catalog.openInOpenClaw")).toBe("Open in OpenClaw");
    expect(manager.t("chat.catalog.importComplete", { count: "3" })).toBe(
      "Imported 3 transcript items.",
    );
    expect(manager.t("chat.catalog.openOriginal")).toBe("Open original");
  },
);
