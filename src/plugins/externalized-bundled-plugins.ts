// Defines metadata for bundled plugins that are installed externally.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

export type ExternalizedBundledPluginBridge = {
  /** Plugin id used while the plugin was bundled in core. */
  bundledPluginId: string;
  /** Plugin id declared by the external package. Defaults to bundledPluginId. */
  pluginId?: string;
  /** npm spec OpenClaw can install when migrating the bundled plugin out. */
  npmSpec?: string;
  /** Catalog integrity pin for npmSpec; only valid for that exact spec. */
  expectedIntegrity?: string;
  /** ClawHub spec OpenClaw can install when migrating the bundled plugin out. */
  clawhubSpec?: string;
  /** Optional ClawHub base URL for non-default registries. */
  clawhubUrl?: string;
  /** Bundled directory name, when it differs from bundledPluginId. */
  bundledDirName?: string;
  /** Previous bundled manifest default enablement from the persisted registry. */
  enabledByDefault?: boolean;
  /** Legacy ids that should be treated as this plugin during enablement checks. */
  legacyPluginIds?: readonly string[];
  /** Channel ids that imply this plugin is enabled when configured. */
  channelIds?: readonly string[];
  /** Plugin ids this external package supersedes for channel selection. */
  preferOver?: readonly string[];
};

export function getExternalizedBundledPluginNpmSpec(
  bridge: ExternalizedBundledPluginBridge,
): string {
  return normalizeOptionalString(bridge.npmSpec) ?? "";
}

export function getExternalizedBundledPluginClawHubSpec(
  bridge: ExternalizedBundledPluginBridge,
): string {
  return normalizeOptionalString(bridge.clawhubSpec) ?? "";
}

export function getExternalizedBundledPluginTargetId(
  bridge: ExternalizedBundledPluginBridge,
): string {
  return (
    normalizeOptionalString(bridge.pluginId) ??
    normalizeOptionalString(bridge.bundledPluginId) ??
    ""
  );
}

export function getExternalizedBundledPluginLookupIds(
  bridge: ExternalizedBundledPluginBridge,
): readonly string[] {
  return normalizeUniqueTrimmedStringList([
    bridge.bundledPluginId,
    bridge.pluginId,
    ...(bridge.legacyPluginIds ?? []),
    ...(bridge.channelIds ?? []),
  ]);
}

export function getExternalizedBundledPluginLegacyPathSuffix(
  bridge: ExternalizedBundledPluginBridge,
): string {
  const bundledDirName = bridge.bundledDirName ?? bridge.bundledPluginId;
  return ["extensions", bundledDirName].join("/");
}
