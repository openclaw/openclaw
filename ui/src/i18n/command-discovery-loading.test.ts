/* @vitest-environment jsdom */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import {
  captureI18nStateForTesting,
  createI18nManagerForTesting,
} from "./lib/translate.test-support.ts";
import { en } from "./locales/en.ts";

vi.hoisted(() => vi.resetModules());
const startup = structuredClone({
  commandPalette: en.commandPalette,
  palette: en.palette,
  shortcutsOverlay: en.shortcutsOverlay,
  sessionsView: en.sessionsView,
  commands: en.chat.commands,
});
let restoreI18n: () => Promise<void>;
beforeEach(() => {
  restoreI18n = captureI18nStateForTesting();
});
afterEach(async () => {
  en.commandPalette = structuredClone(startup.commandPalette);
  en.palette = structuredClone(startup.palette);
  en.shortcutsOverlay = structuredClone(startup.shortcutsOverlay);
  en.sessionsView = structuredClone(startup.sessionsView);
  en.chat.commands = structuredClone(startup.commands);
  await restoreI18n();
});
afterAll(async () => {
  // Previously evaluated consumers remain cached in the shared worker.
  const { registerCommandPaletteEnglish } = await import("./locales/en-command-palette.ts");
  registerCommandPaletteEnglish();
});

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
    const manager = createI18nManagerForTesting(async () => ({ common: { health: "Gesundheit" } }));
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
