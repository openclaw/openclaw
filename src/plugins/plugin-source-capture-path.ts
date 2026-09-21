// Captures must remain recognizable to the native source loader in every scratch location.
export const PLUGIN_SOURCE_CAPTURE_PREFIX = "openclaw-plugin-build-";

export function isLegacyPluginSourceCaptureName(name: string): boolean {
  return (
    name.startsWith(PLUGIN_SOURCE_CAPTURE_PREFIX) || name.startsWith("openclaw-model-catalog-")
  );
}
