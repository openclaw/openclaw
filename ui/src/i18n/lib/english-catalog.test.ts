// @vitest-environment node
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { expect, it, vi } from "vitest";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { registerBoardWebsiteEnglish } from "../locales/en-board-website.ts";
import { en } from "../locales/en.ts";
import { loadLazyLocaleTranslation } from "./registry.ts";
import { captureI18nStateForTesting } from "./translate.test-support.ts";
import { i18n } from "./translate.ts";

vi.hoisted(() => vi.resetModules());

it("invalidates public t for lazy fallback registration without replacing active translations", async () => {
  const restoreI18n = captureI18nStateForTesting();
  const originalGerman = await loadLazyLocaleTranslation("de");
  const widget = en.board.widget;
  const originalWidget = { ...widget };
  const labels: (readonly string[])[] = [];
  let dispose = () => {};
  try {
    i18n.registerTranslation("de", { board: { widget: { websiteOpen: "Webseite öffnen" } } });
    await i18n.setLocale("de");
    dispose = createRoot((stop) => {
      createEffect(
        () => [t("board.widget.websiteOpen"), t("board.widget.websiteEmbedHint")],
        (value) => {
          labels.push(value);
        },
      );
      return stop;
    });
    flush();
    expect(labels).toEqual([["Webseite öffnen", "board.widget.websiteEmbedHint"]]);

    registerEnglishCatalog(registerBoardWebsiteEnglish);
    flush();
    expect(labels.at(-1)).toEqual([
      "Webseite öffnen",
      "If this site does not load here, open it in a new tab.",
    ]);
    expect(en.board.widget).toBe(widget);
    const count = labels.length;
    registerEnglishCatalog(registerBoardWebsiteEnglish);
    flush();
    expect(labels).toHaveLength(count);
  } finally {
    dispose();
    for (const key of Object.keys(widget)) {
      if (!Object.hasOwn(originalWidget, key)) {
        Reflect.deleteProperty(widget, key);
      }
    }
    Object.assign(widget, originalWidget);
    if (originalGerman) {
      i18n.registerTranslation("de", originalGerman);
    }
    await restoreI18n();
  }
});
