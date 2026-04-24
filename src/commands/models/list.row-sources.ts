import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  appendCatalogSupplementRows,
  appendConfiguredProviderRows,
  appendConfiguredRows,
  appendDiscoveredRows,
  appendProviderCatalogRows,
  type RowBuilderContext,
} from "./list.rows.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";

type AllModelRowSources = {
  rows: ModelRow[];
  context: RowBuilderContext;
  modelRegistry?: ModelRegistry;
  useProviderCatalogFastPath: boolean;
};

export function modelRowSourcesRequireRegistry(params: {
  all?: boolean;
  useProviderCatalogFastPath: boolean;
}): boolean {
  return !(params.all && params.useProviderCatalogFastPath);
}

export async function appendAllModelRowSources(params: AllModelRowSources): Promise<void> {
  const seenKeys = appendDiscoveredRows({
    rows: params.rows,
    models: params.modelRegistry?.getAll() ?? [],
    context: params.context,
  });

  appendConfiguredProviderRows({
    rows: params.rows,
    context: params.context,
    seenKeys,
  });

  if (params.modelRegistry) {
    await appendCatalogSupplementRows({
      rows: params.rows,
      modelRegistry: params.modelRegistry,
      context: params.context,
      seenKeys,
    });
    return;
  }

  if (params.useProviderCatalogFastPath) {
    await appendProviderCatalogRows({
      rows: params.rows,
      context: params.context,
      seenKeys,
    });
  }
}

export function appendConfiguredModelRowSources(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
}): void {
  appendConfiguredRows(params);
}
