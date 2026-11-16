import type { SearchSchema, SearchStore } from "./contract.js";
import { admitStoreSearchExtension } from "./search-extension.js";
import { bindStoreSearch } from "./search.js";

/** @experimental Admit an owner's extension, or bind its already admitted indexes. */
export function admitStoreSearch(
  store: SearchStore,
  schema: SearchSchema,
  options?: { extension: string },
) {
  if (options) {
    if ("databasePath" in store) {
      throw new Error("Search extension admission requires the owner's connection");
    }
    return admitStoreSearchExtension(store, options.extension, schema);
  }
  return bindStoreSearch(store, schema);
}
