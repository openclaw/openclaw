import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";

export function managementMetadata(params: {
  id?: string;
  name?: string;
  origin?: "bundled" | "global";
  packageName?: string | null;
  installRecord?: Record<string, unknown>;
  enabled?: boolean;
  featured?: boolean;
  description?: string;
  curated?: boolean;
}) {
  const id = params.id ?? "workboard";
  const packageName =
    params.packageName === null ? undefined : (params.packageName ?? `@openclaw/${id}`);
  const rootDir = `/tmp/${id}`;
  const origin = params.origin ?? "bundled";
  const owner = params.installRecord ? id : undefined;
  const manifest = recordPluginManifestInstallOwner(
    {
      id,
      name: params.name ?? "Workboard",
      origin,
      rootDir,
      source: `${rootDir}/index.ts`,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      ...(params.curated === false
        ? {}
        : {
            description: params.description ?? "Coordinate agent work in a shared board.",
            catalog: { featured: params.featured ?? true, order: 10 },
          }),
    },
    owner,
  );
  const record = recordInstalledPluginIndexInstallOwner(
    {
      pluginId: id,
      ...(packageName ? { packageName } : {}),
      origin,
      rootDir,
      enabled: params.enabled ?? true,
    },
    owner,
  );
  return {
    index: {
      plugins: [record],
      installRecords: params.installRecord
        ? { [id]: { ...params.installRecord, installPath: rootDir } }
        : {},
    },
    byPluginId: new Map([[id, manifest]]),
    plugins: [manifest],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}
