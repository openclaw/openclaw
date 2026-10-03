/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

describe("command discovery English loading", () => {
  it.each([
    {
      surface: "palette search",
      load: () => import("../components/command-palette-catalog-search.ts"),
    },
    { surface: "session transcript search", load: () => import("../pages/sessions/view.ts") },
    { surface: "slash commands", load: () => import("../lib/chat/commands.ts") },
    { surface: "shortcut help", load: () => import("../lib/keyboard-shortcut-catalog.ts") },
  ])("registers fallback copy before $surface reads it", async ({ load }) => {
    const { manager } = await loadI18n();
    expect(manager.t("palette.placeholder")).toBe("Search or start a task…");
    expect(manager.t("palette.categories.navigation")).toBe("Navigation");
    expect(manager.t("shortcutsOverlay.title")).toBe("Keyboard shortcuts");
    expect(manager.t("commandPalette.newSessionSettings")).toBe(
      "commandPalette.newSessionSettings",
    );
    await manager.setLocale("de");
    await load();
    const { registerCommandPaletteEnglish } = await import("./locales/en-command-palette.ts");
    for (const [key, value] of flattenTranslations(registerCommandPaletteEnglish.catalog)) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t("common.health")).toBe("Gesundheit");
    expect(manager.t("commandPalette.newSessionSettings")).toBe("New session settings");
    expect(manager.t("chat.commands.menu")).toBe("Slash commands");
  });
});
