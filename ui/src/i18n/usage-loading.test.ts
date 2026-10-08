/* @vitest-environment jsdom */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

vi.hoisted(() => vi.resetModules());
const startupUsage = structuredClone(en.usage);
let restoreI18n: () => Promise<void>;

beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});

afterEach(async () => {
  en.usage = structuredClone(startupUsage);
  await restoreI18n();
});

afterAll(async () => {
  const { registerUsageEnglish } = await import("./locales/en-usage.ts");
  registerUsageEnglish();
});

describe("Usage English loading", () => {
  it.each([
    { surface: "export", load: () => import("../pages/usage/export.ts") },
    { surface: "Usage view", load: () => import("../pages/usage/view.ts") },
  ])("loads fallback copy before $surface can use it", async ({ load }) => {
    const manager = createI18nManagerForTesting(async () => ({
      common: { health: "Gesundheit" },
      usage: { presets: { today: "Heute" } },
    }));
    expect(manager.t("usage.heatmap.title")).toBe("Token Activity");
    expect(manager.t("usage.scope.instance")).toBe("usage.scope.instance");
    expect(manager.t("usage.export.label")).toBe("usage.export.label");

    await manager.setLocale("de");
    await load();

    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("usage.presets.today")).toBe("Heute");
    expect(manager.t("usage.presets.last30d")).toBe("30d");
    expect(manager.t("usage.scope.instance")).toBe("Current instance");
    expect(manager.t("usage.scope.familyIncluded", { count: "2" })).toBe(
      "Historical lineage includes 2 session instances.",
    );
    expect(manager.t("usage.export.label")).toBe("Export");
    expect(manager.t("usage.export.changed")).toBe(
      "Session context changed while preparing the export. Refresh usage and try again.",
    );
  });
});
