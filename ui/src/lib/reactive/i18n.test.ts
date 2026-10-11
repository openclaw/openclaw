// @vitest-environment node
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { afterEach, expect, it, vi } from "vitest";
import { createI18nManagerForTesting } from "../../i18n/lib/translate.test-support.ts";
import { projectI18n, registerLocaleCatalog } from "./i18n.ts";

afterEach(() => vi.unstubAllGlobals());

it("tracks locale and same-locale catalog changes with the existing t call shape", async () => {
  vi.stubGlobal("navigator", { language: "en" });
  const first = createI18nManagerForTesting(async () => null);
  const second = createI18nManagerForTesting(async () => null);
  first.registerTranslation("de", { greeting: "Hallo {name}" });
  const translator = projectI18n(first);
  const sibling = projectI18n(first);
  const siblingChanged = vi.fn();
  const stopSibling = sibling.subscribe(siblingChanged);
  const labels: string[] = [];
  const dispose = createRoot((stop) => {
    createEffect(
      () => translator.t("greeting", { name: "Ada" }),
      (text) => {
        labels.push(text);
      },
    );
    return stop;
  });
  flush();
  try {
    expect(labels).toEqual(["greeting"]);
    await first.setLocale("de");
    flush();
    expect(labels.at(-1)).toBe("Hallo Ada");
    siblingChanged.mockClear();
    registerLocaleCatalog(first, "de", { greeting: "Guten Tag {name}" });
    flush();
    expect(labels.at(-1)).toBe("Guten Tag Ada");
    expect(siblingChanged).toHaveBeenCalledOnce();
    translator.replaceSource(second);
    flush();
    expect(labels.at(-1)).toBe("greeting");
    translator.dispose();
    const count = labels.length;
    registerLocaleCatalog(second, "en", { greeting: "Hello {name}" });
    flush();
    expect(labels).toHaveLength(count);
  } finally {
    translator.dispose();
    stopSibling();
    sibling.dispose();
    dispose();
  }
});
