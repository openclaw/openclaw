import type { TranslationMap } from "./types.ts";

type LazyLocaleCatalog = {
  prepare: () => Promise<void>;
  load: (namespace: string) => Promise<void> | undefined;
};

const catalogs = new WeakMap<TranslationMap, LazyLocaleCatalog>();

export function registerLazyLocaleCatalog(
  catalog: TranslationMap,
  loader: LazyLocaleCatalog,
): void {
  catalogs.set(catalog, loader);
}

export function getLazyLocaleCatalog(catalog: TranslationMap): LazyLocaleCatalog | undefined {
  return catalogs.get(catalog);
}
