import { listPluginCompatRecords } from "./compat/registry.js";
import { recordPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";

// Exact subpaths only: a deprecated member does not deprecate its whole module.
const deprecatedSubpaths = new Map(
  listPluginCompatRecords().flatMap((record) =>
    record.status === "deprecated" || record.status === "removal-pending"
      ? record.surfaces
          .filter((surface) => /^openclaw\/plugin-sdk\/[a-z0-9-]+$/u.test(surface))
          .map((surface) => [surface, record] as const)
      : [],
  ),
);

export function recordPluginSdkDeprecatedImport(pluginId: string, specifier: string): void {
  const subpath = specifier
    .replace(/^@openclaw\/plugin-sdk\//u, "openclaw/plugin-sdk/")
    .replace(/\.js$/u, "");
  const record = deprecatedSubpaths.get(subpath);
  if (record) {
    recordPluginSdkDeprecationUsage(
      pluginId,
      subpath,
      subpath,
      record.replacement ?? "See the Plugin SDK migration guide.",
      record.removeAfter,
    );
  }
}
