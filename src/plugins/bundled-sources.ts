import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifest } from "./manifest.js";

export type BundledPluginSource = {
  pluginId: string;
  localPath: string;
  npmSpec?: string;
};

export type BundledPluginLookup =
  | { kind: "npmSpec"; value: string }
  | { kind: "pluginId"; value: string };

export function resolveBundledPluginSources(params: {
  workspaceDir?: string;
}): Map<string, BundledPluginSource> {
  const discovery = discoverOpenClawPlugins({ workspaceDir: params.workspaceDir });
  const bundled = new Map<string, BundledPluginSource>();

  for (const candidate of discovery.candidates) {
    if (candidate.origin !== "bundled") {
      continue;
    }
    const manifest = loadPluginManifest(candidate.rootDir, false);
    if (!manifest.ok) {
      continue;
    }
    const pluginId = manifest.manifest.id;
    if (bundled.has(pluginId)) {
      continue;
    }

    // Private packages are not published to npm, so only use an explicit
    // install.npmSpec when present. Falling back to packageName for private
    // packages would cause the updater to try to npm-install a package that
    // does not exist (e.g. @openclaw/memory-lancedb).
    const explicitNpmSpec = candidate.packageManifest?.install?.npmSpec?.trim();
    const npmSpec =
      explicitNpmSpec ||
      (candidate.packagePrivate ? undefined : candidate.packageName?.trim()) ||
      undefined;

    bundled.set(pluginId, {
      pluginId,
      localPath: candidate.rootDir,
      npmSpec,
    });
  }

  return bundled;
}

export function findBundledPluginSource(params: {
  lookup: BundledPluginLookup;
  workspaceDir?: string;
}): BundledPluginSource | undefined {
  const targetValue = params.lookup.value.trim();
  if (!targetValue) {
    return undefined;
  }
  const bundled = resolveBundledPluginSources({ workspaceDir: params.workspaceDir });
  if (params.lookup.kind === "pluginId") {
    return bundled.get(targetValue);
  }
  for (const source of bundled.values()) {
    if (source.npmSpec === targetValue) {
      return source;
    }
  }
  return undefined;
}
