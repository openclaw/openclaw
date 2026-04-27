import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function normalizeArtifactBasename(artifactBasename: string): string {
  return artifactBasename.replace(/^\.\/+/u, "").replace(/^\/+/u, "");
}

function resolveSourceArtifactPath(packageDir: string, artifactBasename: string): string {
  const artifactPath = path.resolve(packageDir, normalizeArtifactBasename(artifactBasename));
  if (artifactPath.endsWith(".js")) {
    const sourcePath = `${artifactPath.slice(0, -".js".length)}.ts`;
    if (fs.existsSync(sourcePath)) {
      return sourcePath;
    }
  }
  return artifactPath;
}

function resolveExtensionDirByManifestId(pluginId: string): string {
  const pluginDir = path.resolve(repoRoot, "extensions", pluginId);
  const manifest = readJson<{ id?: unknown }>(path.join(pluginDir, "openclaw.plugin.json"));
  if (manifest?.id === pluginId) {
    return pluginDir;
  }
  throw new Error(`Unknown bundled plugin id: ${pluginId}`);
}

function resolveWorkspacePackageDir(packageName: string): string {
  const extensionsDir = path.resolve(repoRoot, "extensions");
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(extensionsDir, entry.name);
    const manifest = readJson<{ name?: unknown }>(path.join(packageDir, "package.json"));
    if (manifest?.name === packageName) {
      return packageDir;
    }
  }
  throw new Error(`Unknown workspace package: ${packageName}`);
}

export async function loadBundledPluginPublicSurface<T extends object>(params: {
  pluginId: string;
  artifactBasename: string;
}): Promise<T> {
  const artifactPath = resolveSourceArtifactPath(
    resolveExtensionDirByManifestId(params.pluginId),
    params.artifactBasename,
  );
  return (await import(pathToFileURL(artifactPath).href)) as T;
}

export function loadBundledPluginPublicSurfaceSync<T extends object>(_params: {
  pluginId: string;
  artifactBasename: string;
}): T {
  throw new Error("Synchronous bundled plugin public-surface loading is not available here");
}

export function resolveWorkspacePackagePublicModuleUrl(params: {
  packageName: string;
  artifactBasename: string;
}): string {
  const artifactPath = resolveSourceArtifactPath(
    resolveWorkspacePackageDir(params.packageName),
    params.artifactBasename,
  );
  return pathToFileURL(artifactPath).href;
}
