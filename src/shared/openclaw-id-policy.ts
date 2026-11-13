/** Canonical opt-in for OpenClaw ID runtime and presentation boundaries. */
export function isOpenClawIdEnabled(config: { enabled?: boolean } | undefined): boolean {
  return config?.enabled === true;
}

/** Feature-owned plugin surfaces are absent until their owning feature is enabled. */
export function isOpenClawIdPluginVisible(
  pluginId: string,
  config: { gateway?: { openclawId?: { enabled?: boolean } } } | null | undefined,
): boolean {
  return pluginId !== "openclaw-id-access" || isOpenClawIdEnabled(config?.gateway?.openclawId);
}

/** A list filter that drops feature-owned plugins while their feature is off. */
export function idFeatureVisible(
  config: Parameters<typeof isOpenClawIdPluginVisible>[1],
): (plugin: { id: string }) => boolean {
  return (plugin) => isOpenClawIdPluginVisible(plugin.id, config);
}
