export function clearPluginManifestRegistryCache(): void {
  // Manifest registry loads are intentionally uncached. Keep this legacy hook
  // as a compatibility no-op for tests and older reset call sites.
}
