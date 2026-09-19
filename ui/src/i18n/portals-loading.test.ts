/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { titleForRoute } from "../app-navigation.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

vi.hoisted(() => vi.resetModules());

const startupPortals = structuredClone(expectDefined(en.portalsPage, "Portals catalog anchor"));
let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});

afterEach(async () => {
  en.portalsPage = structuredClone(startupPortals);
  await restoreI18n();
});

afterAll(async () => {
  // Cached pages must retain their fallback copy for later shared-worker tests.
  const { registerPortalsEnglish } = await import("./locales/en-portals.ts");
  registerPortalsEnglish();
});

describe("Portals English loading", () => {
  it("keeps navigation eager and loads complete fallback copy before the page renders", async () => {
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
});
