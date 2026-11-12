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
      catalog: async () =>
        (await import("./locales/en-command-palette.ts")).registerCommandPaletteEnglish.catalog,
      unopenedKey: "shortcutsOverlay.labels.sendMessage",
    },
    {
      surface: "shortcut help",
      load: () => import("../components/keyboard-shortcuts-dialog.tsx"),
      catalog: async () =>
        (await import("./locales/en-keyboard-shortcuts.ts")).registerKeyboardShortcutsEnglish
          .catalog,
      unopenedKey: "commandPalette.newSessionSettings",
    },
  ])("registers fallback copy before $surface reads it", async ({ load, catalog, unopenedKey }) => {
    const { manager } = await loadI18n();
    expect(manager.t("palette.placeholder")).toBe("Search or start a task…");
    expect(manager.t("palette.categories.navigation")).toBe("Navigation");
    expect(manager.t("shortcutsOverlay.title")).toBe("Keyboard shortcuts");
    expect(manager.t("commandPalette.newSessionSettings")).toBe(
      "commandPalette.newSessionSettings",
    );
    await manager.setLocale("de");
    await load();
    for (const [key, value] of flattenTranslations(await catalog())) {
      expect(manager.t(key)).toBe(value);
    }
    expect(manager.t(unopenedKey)).toBe(unopenedKey);
    expect(manager.t("common.health")).toBe("Gesundheit");
  });

  it.each<[key: string, expected: string, load: () => Promise<unknown>]>([
    [
      "sessionsView.transcriptSearchTitle",
      "Search transcripts",
      () => import("../pages/sessions/view.tsx"),
    ],
    ["chat.commands.menu", "Slash commands", () => import("../lib/chat/commands.ts")],
    [
      "chat.welcome.recentSessions",
      "Recent sessions",
      () => import("../pages/chat/components/chat-welcome.tsx"),
    ],
  ])("loads only %s copy before discovery opens", async (key, expected, load) => {
    const { manager } = await loadI18n();
    await manager.setLocale("de");
    await load();
    expect(manager.t(key)).toBe(expected);
    expect(manager.t("commandPalette.newSessionSettings")).toBe(
      "commandPalette.newSessionSettings",
    );
    expect(manager.t("shortcutsOverlay.labels.sendMessage")).toBe(
      "shortcutsOverlay.labels.sendMessage",
    );
    expect(manager.t("common.health")).toBe("Gesundheit");
    const { registerCommandPaletteEnglish } = await import("./locales/en-command-palette.ts");
    registerCommandPaletteEnglish();
    expect(manager.t("commandPalette.newSessionSettings")).toBe("New session settings");
    expect(manager.t("shortcutsOverlay.labels.sendMessage")).toBe(
      "shortcutsOverlay.labels.sendMessage",
    );
    const { registerKeyboardShortcutsEnglish } = await import("./locales/en-keyboard-shortcuts.ts");
    registerKeyboardShortcutsEnglish();
    expect(manager.t("shortcutsOverlay.labels.sendMessage")).toBe("Send message");
  });
});
