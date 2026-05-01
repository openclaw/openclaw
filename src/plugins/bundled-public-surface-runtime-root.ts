import path from "node:path";

export type BundledPublicSurfaceLocation = {
  modulePath: string;
  boundaryRoot: string;
};

function isBuiltBundledPluginRoot(rootDir: string): boolean {
  return rootDir.replace(/\\/g, "/").includes("/dist/extensions/");
}

export function resolveBuiltBundledPluginRootFromModulePath(params: {
  modulePath: string;
  pluginId: string;
}): string | null {
  const resolvedModulePath = path.resolve(params.modulePath);
  let currentDir = path.dirname(resolvedModulePath);
  while (true) {
    if (path.basename(currentDir) === params.pluginId && isBuiltBundledPluginRoot(currentDir)) {
      const relativePath = path.relative(currentDir, resolvedModulePath);
      if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
        return currentDir;
      }
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function prepareBuiltBundledPluginPublicSurfaceLocation(params: {
  location: BundledPublicSurfaceLocation;
  pluginId: string;
  env?: NodeJS.ProcessEnv;
  installRuntimeDeps?: boolean;
}): BundledPublicSurfaceLocation {
  return params.location;
}
