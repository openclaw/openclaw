import { getOrCreatePromise } from "../../../../src/shared/lazy-promise.ts";
import { registerLazyLocaleCatalog } from "./locale-catalog.ts";
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

function mergeCatalog(target: TranslationMap, source: TranslationMap): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      target[key] = value;
    } else {
      const nested = target[key];
      mergeCatalog((target[key] = typeof nested === "object" ? nested : {}), value);
    }
  }
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
