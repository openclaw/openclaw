import type { HostedOfficialExternalPluginCatalogSnapshot } from "./official-external-plugin-catalog.types.js";

export type HostedCatalogSnapshotWorkerOperations = {
  "plugins.catalogSnapshot.read": {
    input: { url: string };
    output: HostedOfficialExternalPluginCatalogSnapshot | null;
  };
  "plugins.catalogSnapshot.write": {
    input: { snapshot: HostedOfficialExternalPluginCatalogSnapshot; now: number };
    output: { ok: true } | { ok: false; message: string };
  };
};
