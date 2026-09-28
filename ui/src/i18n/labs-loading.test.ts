/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { titleForRoute } from "../app-navigation.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

vi.hoisted(() => vi.resetModules());

const startupLabs = structuredClone(en.labsPage);
let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});

afterEach(async () => {
  en.labsPage = structuredClone(startupLabs);
  await restoreI18n();
});

afterAll(async () => {
  // Cached Labs consumers need fallback copy in later shared-worker tests.
  const { registerLabsEnglish } = await import("./locales/en-labs.ts");
  registerLabsEnglish();
});

describe("Labs English loading", () => {
  it("keeps shared copy eager and loads feature fallback copy at the Labs boundary", async () => {
    const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
    expect(titleForRoute("labs")).toBe("Labs");
    expect(manager.t("labsPage.restartRequired")).toBe("Gateway restart required.");
    expect(manager.t("labsPage.swarm.progress", { complete: "1", total: "2" })).toBe("1 of 2");
    expect(manager.t("labsPage.codeMode.description")).toBe("labsPage.codeMode.description");

    await manager.setLocale("de");
    const catalog = en.labsPage;
    const swarm = catalog.swarm;
    const { LAB_FEATURES } = await import("../pages/labs/labs-registry.ts");
    const { registerLabsEnglish } = await import("./locales/en-labs.ts");
    for (const [key, value] of flattenTranslations(registerLabsEnglish.catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    for (const feature of LAB_FEATURES) {
      expect(feature.title()).toBe(manager.t(`labsPage.${feature.id}.title`));
      expect(feature.description()).toBe(manager.t(`labsPage.${feature.id}.description`));
    }
    expect(en.labsPage).toBe(catalog);
    expect(en.labsPage.swarm).toBe(swarm);
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(titleForRoute("labs")).toBe("Labs");
  });
});
