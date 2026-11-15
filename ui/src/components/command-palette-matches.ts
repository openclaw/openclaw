import { createMemo } from "solid-js";
import { i18nRevision } from "../lib/reactive/i18n.ts";
import {
  filterCommandPaletteItems,
  getStaticCommandPaletteCatalogItems,
} from "./command-palette-catalog-search.ts";
import type { CommandPaletteState } from "./command-palette-state.ts";

/** Prepare catalog and query results independently of selection-only publications. */
export function createCommandPaletteMatches(
  read: () => ReturnType<CommandPaletteState["readProps"]>,
) {
  const catalogInputs = createMemo(
    () => {
      const snapshot = read();
      return [
        snapshot.canAdmin,
        snapshot.nativeDeviceSettings,
        snapshot.nativeDeviceSettings?.snapshot,
        snapshot.catalogItems,
        snapshot.modelItems,
      ] as const;
    },
    { equals: (a, b) => a.every((value, index) => value === b[index]) },
  );
  const catalogItems = createMemo(() => {
    i18nRevision();
    const [canAdmin, nativeDeviceSettings, , loaded, models] = catalogInputs();
    return [
      ...getStaticCommandPaletteCatalogItems(canAdmin, nativeDeviceSettings),
      ...loaded,
      ...models,
    ];
  });
  const matchInputs = createMemo(
    () => {
      const snapshot = read();
      return [
        snapshot.searchQuery,
        Boolean(snapshot.onSlashCommand),
        snapshot.sessionItems,
        catalogItems(),
        snapshot.desktopAvailable,
        snapshot.custodianAvailable,
        snapshot.primaryModelSearch,
        snapshot.mode === "compose",
      ] as const;
    },
    { equals: (a, b) => a.every((value, index) => value === b[index]) },
  );
  return createMemo(() => {
    const [
      query,
      includeSlashCommands,
      sessionItems,
      preparedCatalog,
      desktopAvailable,
      custodianAvailable,
      primaryModelSearch,
      hidden,
    ] = matchInputs();
    return hidden
      ? []
      : filterCommandPaletteItems({
          query,
          includeSlashCommands,
          sessionItems,
          catalogItems: preparedCatalog,
          desktopAvailable,
          custodianAvailable,
          primaryModelSearch,
        });
  });
}
