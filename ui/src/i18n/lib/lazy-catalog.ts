import type { TranslationMap } from "./types.ts";

type NamespaceLoader = () => Promise<{ default: TranslationMap }>;
const loadersByCatalog = new WeakMap<TranslationMap, Record<string, NamespaceLoader>>();

// Vite supplies the same base/page split as English, using canonical translation memory.
export function createLazyLocaleCatalog(
  base: TranslationMap,
  loaders: Record<string, NamespaceLoader>,
): TranslationMap {
  loadersByCatalog.set(base, loaders);
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

export function getLocaleNamespaceLoader(
  catalog: TranslationMap,
  namespace: string,
): (() => Promise<void>) | undefined {
  const loaders = loadersByCatalog.get(catalog);
  const load = loaders?.[namespace];
  if (!load) {
    return undefined;
  }
  return async () => {
    mergeCatalog(catalog, (await load()).default);
    delete loaders[namespace];
  };
}
