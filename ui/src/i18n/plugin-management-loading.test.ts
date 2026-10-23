/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

it("keeps ClawHub labels eager without loading plugin management copy", async () => {
  const { manager } = await loadI18n();
  await manager.setLocale("de");
  await import("../pages/chat/components/chat-clawhub-card.tsx");
  expect(manager.t("pluginsPage.official")).toBe("Official");
  expect(manager.t("pluginsPage.install")).toBe("Install");
  expect(manager.t("pluginsPage.installed")).toBe("Installed");
  expect(manager.t("pluginsPage.installNamed", { name: "Example" })).toBe(
    "pluginsPage.installNamed",
  );

  const { registerPluginManagementEnglish } = await import("./locales/en-plugin-management.ts");
  registerPluginManagementEnglish();
  expect(manager.t("pluginsPage.installNamed", { name: "Example" })).toBe("Install Example");
  expect(manager.t("pluginsPage.installed")).toBe("Installed");
  expect(manager.t("common.health")).toBe("Gesundheit");
});
