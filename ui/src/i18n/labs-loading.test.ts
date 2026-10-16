/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("keeps shared copy eager and loads feature fallback copy at the Labs boundary", async () => {
  const { en, manager } = await loadI18n();
  const { titleForRoute } = await import("../app-navigation.ts");
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
