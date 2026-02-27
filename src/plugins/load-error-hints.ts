export type PluginMissingDependencyHintParams = {
  message: string;
  pluginId?: string;
};

function extractMissingModuleSpecifier(message: string): string | null {
  const patterns = [
    /Cannot find module ['"]([^'"]+)['"]/i,
    /Cannot find package ['"]([^'"]+)['"]/i,
    /ERR_MODULE_NOT_FOUND[\s\S]*?['"]([^'"]+)['"]/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (!match) {
      continue;
    }
    const spec = match[1]?.trim();
    if (spec) {
      return spec;
    }
  }
  return null;
}

function isLikelyDependencySpecifier(spec: string): boolean {
  if (!spec) {
    return false;
  }
  if (spec.startsWith(".") || spec.startsWith("/")) {
    return false;
  }
  if (spec.startsWith("file:")) {
    return false;
  }
  if (/^[a-z]:[\\/]/i.test(spec)) {
    return false;
  }
  return true;
}

export function resolvePluginMissingDependencyHint(
  params: PluginMissingDependencyHintParams,
): string | null {
  const specifier = extractMissingModuleSpecifier(params.message);
  if (!specifier || !isLikelyDependencySpecifier(specifier)) {
    return null;
  }
  const updateCommand = params.pluginId
    ? `openclaw plugins update ${params.pluginId}`
    : "openclaw plugins update <plugin-id>";
  return (
    `Missing dependency "${specifier}". If this plugin was installed from npm, run "${updateCommand}". ` +
    'Otherwise reinstall the plugin or run "npm install --omit=dev" in the plugin directory.'
  );
}
