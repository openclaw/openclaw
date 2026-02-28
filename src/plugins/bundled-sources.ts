import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifest } from "./manifest.js";

export type BundledPluginSource = {
  pluginId: string;
  localPath: string;
  npmSpec?: string;
};

export function resolveBundledPluginSources(params: {
  workspaceDir?: string;
}): Map<string, BundledPluginSource> {
  const discovery = discoverOpenClawPlugins({ workspaceDir: params.workspaceDir });
  const bundled = new Map<string, BundledPluginSource>();

  for (const candidate of discovery.candidates) {
    if (candidate.origin !== "bundled") {
      continue;
    }
    const manifest = loadPluginManifest(candidate.rootDir);
    if (!manifest.ok) {
      continue;
    }
    const pluginId = manifest.manifest.id;
    if (bundled.has(pluginId)) {
      continue;
    }

    const npmSpec =
      candidate.packageManifest?.install?.npmSpec?.trim() ||
      candidate.packageName?.trim() ||
      undefined;

    bundled.set(pluginId, {
      pluginId,
      localPath: candidate.rootDir,
      npmSpec,
    });
  }

  return bundled;
}

export function findBundledPluginByNpmSpec(params: {
  spec: string;
  workspaceDir?: string;
}): BundledPluginSource | undefined {
  const targetSpec = params.spec.trim();
  if (!targetSpec) {
    return undefined;
  }
  const bundled = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
  for (const source of bundled.values()) {
    if (source.npmSpec === targetSpec) {
      return source;
    }
  }
  return undefined;
}
