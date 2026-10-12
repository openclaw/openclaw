/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

// mock-isolation: Cold catalog imports test page-owned copy, without registering child elements.
vi.mock("../components/native-chrome-setup.ts", () => ({}));

const loadI18n = useLazyEnglishTest();

describe("Apps English loading", () => {
  it.each([
    { surface: "Apps", load: () => import("../pages/apps/view.tsx") },
    {
      surface: "command palette",
      load: () => import("../components/command-palette-catalog-search.ts"),
    },
    { surface: "device settings", load: () => import("../pages/device/device-page.tsx") },
  ])("loads complete fallback copy before $surface can render", async ({ load }) => {
    const { manager } = await loadI18n();
    expect(manager.t("tabs.apps")).toBe("Apps");
    expect(manager.t("appsPage.heroTitle")).toBe("appsPage.heroTitle");

    await manager.setLocale("de");
    await load();
    const { registerAppsEnglish } = await import("./locales/en-apps.ts");
    for (const [key, value] of flattenTranslations(registerAppsEnglish.catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("appsPage.heroTitle")).toBe("Take OpenClaw everywhere");
    expect(manager.t("appsPage.cards.ios.title")).toBe("iPhone");
    expect(manager.t("appsPage.ctaChromeWebStore")).toBe("Chrome Web Store");
  });
});
