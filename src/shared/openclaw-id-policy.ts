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
