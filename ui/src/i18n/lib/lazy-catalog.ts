import { getOrCreatePromise } from "../../../../src/shared/lazy-promise.ts";
import { registerLazyLocaleCatalog } from "./locale-catalog.ts";
import { mergeCatalog } from "./merge-catalog.ts";
import type { TranslationMap } from "./types.ts";

type NamespaceLoader = () => Promise<{ default: TranslationMap }>;

// Vite supplies the same base/page split as English, using canonical translation memory.
export function createLazyLocaleCatalog(
  base: TranslationMap,
  loaders: Record<string, NamespaceLoader>,
): TranslationMap {
  const pending = new Map<string, Promise<void>>();
  const load = (namespace: string) => {
    const loader = loaders[namespace];
    if (!loader) {
      return undefined;
    }
    return getOrCreatePromise(
      pending,
      namespace,
      async () => {
        mergeCatalog(base, (await loader()).default);
        delete loaders[namespace];
      },
      { evictOnSettled: true },
    );
  };
  registerLazyLocaleCatalog(base, {
    load,
    async prepare(english) {
      // A language change must translate already-loaded English surfaces before
      // publishing. Empty English anchors keep unopened pages lazy.
      await Promise.all(
        Object.keys(loaders)
          .filter((namespace) => hasMissingEnglish(english[namespace], base[namespace]))
          .map(load)
          .filter((request) => request !== undefined),
      );
    },
  });
  return base;
}

function hasMissingEnglish(
  english: string | TranslationMap | undefined,
  translated: string | TranslationMap | undefined,
): boolean {
  if (typeof english === "string") {
    return typeof translated !== "string";
  }
  return Object.entries(english ?? {}).some(([key, value]) =>
    hasMissingEnglish(value, typeof translated === "object" ? translated[key] : undefined),
  );
}
