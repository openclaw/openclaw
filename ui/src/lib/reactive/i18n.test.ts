// @vitest-environment node
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { afterEach, expect, it, vi } from "vitest";
import { createI18nManagerForTesting } from "../../i18n/lib/translate.test-support.ts";
import { projectI18n } from "./i18n.ts";

afterEach(() => vi.unstubAllGlobals());

it("tracks locale changes and replaces its source with the existing t call shape", async () => {
  vi.stubGlobal("navigator", { language: "en" });
  const first = createI18nManagerForTesting(async () => null);
  const second = createI18nManagerForTesting(async () => null);
  first.registerTranslation("de", { greeting: "Hallo {name}" });
  const translator = projectI18n(first);
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
    translator.replaceSource(second);
    flush();
    expect(labels.at(-1)).toBe("greeting");
  } finally {
    translator.dispose();
    dispose();
  }
});
