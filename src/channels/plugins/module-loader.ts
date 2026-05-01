import fs from "node:fs";
import path from "node:path";
import { openBoundaryFileSync } from "../../infra/boundary-file-read.js";
import {
  getCachedPluginJitiLoader,
  type PluginJitiLoaderCache,
} from "../../plugins/jiti-loader-cache.js";

const jitiLoaders: PluginJitiLoaderCache = new Map();

function loadModule(modulePath: string, tryNative?: boolean) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
    argvEntry: process.argv[1],
    preferBuiltDist: true,
    jitiFilename: import.meta.url,
    tryNative,
  });
}

function resolvePluginModuleCandidates(rootDir: string, specifier: string): string[] {
  const normalizedSpecifier = specifier.replace(/\\/g, "/");
  const resolvedPath = path.resolve(rootDir, normalizedSpecifier);
  const ext = path.extname(resolvedPath);
  if (ext) {
    return [resolvedPath];
  }
  return [
    resolvedPath,
    `${resolvedPath}.ts`,
    `${resolvedPath}.mts`,
    `${resolvedPath}.js`,
    `${resolvedPath}.mjs`,
    `${resolvedPath}.cts`,
    `${resolvedPath}.cjs`,
  ];
}

export function resolveExistingPluginModulePath(rootDir: string, specifier: string): string {
  for (const candidate of resolvePluginModuleCandidates(rootDir, specifier)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.resolve(rootDir, specifier);
}

export function loadChannelPluginModule(params: {
  modulePath: string;
  rootDir: string;
  boundaryRootDir?: string;
  boundaryLabel?: string;
  shouldTryNativeRequire?: (safePath: string) => boolean;
}): unknown {
  const opened = openBoundaryFileSync({
    absolutePath: params.modulePath,
    rootPath: params.boundaryRootDir ?? params.rootDir,
    boundaryLabel: params.boundaryLabel ?? "plugin root",
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error(
      `${params.boundaryLabel ?? "plugin"} module path escapes plugin root or fails alias checks`,
    );
  }
  const safePath = opened.path;
  fs.closeSync(opened.fd);
  return loadModule(safePath, params.shouldTryNativeRequire?.(safePath))(safePath);
}
