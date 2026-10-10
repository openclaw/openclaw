/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { titleForRoute } from "../app-navigation.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";

vi.hoisted(() => vi.resetModules());

let restoreI18n: () => Promise<void>;

afterEach(() => restoreI18n());

it("keeps navigation eager and loads complete fallback copy before the page renders", async () => {
  restoreI18n = captureI18nStateForTesting();
  const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
  expect(titleForRoute("portals")).toBe("Portals");
  expect(manager.t("tabs.portals")).toBe("Portals");
  expect(manager.t("portalsPage.emptyHint")).toBe("portalsPage.emptyHint");

  await manager.setLocale("de");
  await import("../pages/portals/portals-page.ts");
  const { registerPortalsEnglish } = await import("./locales/en-portals.ts");
  for (const [key, value] of flattenTranslations(registerPortalsEnglish.catalog)) {
    expect(manager.t(key)).toBe(value);
  }
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.t("portalsPage.emptyHint")).toBe("Ask the agent to start a portal:");
  expect(manager.t("portalsPage.portLabel", { port: "3000" })).toBe("Port 3000");
  expect(titleForRoute("portals")).toBe("Portals");
});
