import type { TranslationMap } from "./types.ts";

type LazyLocaleCatalog = {
  prepare: (english: TranslationMap) => Promise<void>;
  load: (namespace: string) => Promise<void> | undefined;
};

const localeCatalog = Symbol.for("openclaw.i18n.catalog");
type Catalog = TranslationMap & { [localeCatalog]?: LazyLocaleCatalog };

export function registerLazyLocaleCatalog(
  catalog: TranslationMap,
  loader: LazyLocaleCatalog,
): void {
  // Keep the loader with its catalog across Vite module reloads, outside key enumeration.
  Object.defineProperty(catalog, localeCatalog, { value: loader });
}

export function getLazyLocaleCatalog(catalog: Catalog): LazyLocaleCatalog | undefined {
  return catalog[localeCatalog];
}
