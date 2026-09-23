export function requireExpectedPluginId(params: { expectedPluginId?: string }): string {
  if (!params.expectedPluginId) {
    throw new Error("Expected npm install params to include expectedPluginId");
  }
  return params.expectedPluginId;
}

export function requirePluginPackageName(
  plugins: Array<{ pluginId: string; packageName: string }>,
  pluginId: string,
): string {
  const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Expected plugin fixture ${pluginId}`);
  }
  return plugin.packageName;
}
