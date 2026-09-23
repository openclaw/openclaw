/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

// Each consumer must work before another lazy surface has registered its copy.
vi.hoisted(() => vi.resetModules());

const startupApps = structuredClone(expectDefined(en.appsPage, "Apps catalog anchor"));
let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});

afterEach(async () => {
  en.appsPage = structuredClone(startupApps);
  await restoreI18n();
});

afterAll(async () => {
  // Cached consumers must retain their copy for later tests in the shared worker.
  const { registerAppsEnglish } = await import("./locales/en-apps.ts");
  registerAppsEnglish();
});

describe("Apps English loading", () => {
  it.each([
    { surface: "Apps", load: () => import("../pages/apps/view.ts") },
    {
      surface: "command palette",
      load: () => import("../components/command-palette-catalog-search.ts"),
    },
    { surface: "device settings", load: () => import("../pages/device/device-page.ts") },
  ])("loads complete fallback copy before $surface can render", async ({ load }) => {
    const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
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
