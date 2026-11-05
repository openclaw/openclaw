import { expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it.each([
  { surface: "config form", load: () => import("../components/config-form.render.tsx") },
  { surface: "Setup", load: () => import("../pages/config/setup.tsx") },
  { surface: "Settings search", load: () => import("../pages/config/settings-search.ts") },
])("loads Settings section fallback copy before $surface uses it", async ({ load }) => {
  const { manager, en } = await loadI18n();
  const configForm = en.configForm;
  const sections = configForm.sections;
  const fieldOrder = Object.keys(configForm);
  const namespaceOrder = Object.keys(en);

  expect(manager.t("configForm.defaultValue", { value: "3" })).toBe("Default: 3");
  expect(manager.t("configForm.sections.gateway.label")).toBe("configForm.sections.gateway.label");

  await manager.setLocale("de");
  await load();

  const { registerSettingsEnglish } = await import("./locales/en-settings.ts");
  for (const [key, text] of flattenTranslations({
    configForm: registerSettingsEnglish.catalog.configForm,
  })) {
    expect(manager.t(key)).toBe(text);
  }
  expect(en.configForm).toBe(configForm);
  expect(en.configForm.sections).toBe(sections);
  expect(Object.keys(en)).toEqual(namespaceOrder);
  expect(Object.keys(en.configForm).slice(0, fieldOrder.length)).toEqual(fieldOrder);
  expect(Object.keys(en.configForm.sections)).toEqual(
    Object.keys(registerSettingsEnglish.catalog.configForm.sections),
  );
  expect(manager.t("common.health")).toBe("Gesundheit");
  expect(manager.t("configForm.sections.wizard.label")).toBe("Setup");
  expect(manager.t("configForm.sections.cron.label")).toBe("Automations");
});
