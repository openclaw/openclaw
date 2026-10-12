import { afterEach, beforeEach, vi } from "vitest";
import type { TranslationMap } from "./lib/types.ts";

export function useLazyEnglishTest() {
  let restoreI18n: (() => Promise<void>) | undefined;
  // Each consumer starts with cold English and module state; never clear copy
  // beneath a cached consumer that will not run its registrar again.
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    await restoreI18n?.();
  });

  return async (translation: TranslationMap = { common: { health: "Gesundheit" } }) => {
    const { captureI18nStateForTesting, createI18nManagerForTesting } =
      await import("./lib/translate.test-support.ts");
    restoreI18n = captureI18nStateForTesting();
    const { en } = await import("./locales/en.ts");
    return { en, manager: createI18nManagerForTesting(async () => translation) };
  };
}
