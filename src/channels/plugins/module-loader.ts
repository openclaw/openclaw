import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createJiti } from "jiti";
import { openBoundaryFileSync } from "../../infra/boundary-file-read.js";
import {
  buildPluginLoaderJitiOptions,
  resolvePluginLoaderJitiConfig,
} from "../../plugins/sdk-alias.js";

const nodeRequire = createRequire(import.meta.url);

function createModuleLoader() {
  const jitiLoaders = new Map<string, ReturnType<typeof createJiti>>();

  return (modulePath: string) => {
    const { tryNative, aliasMap, cacheKey } = resolvePluginLoaderJitiConfig({
      modulePath,
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      preferBuiltDist: true,
    });
    const cached = jitiLoaders.get(cacheKey);
    if (cached) {
      return cached;
    }
    const loader = createJiti(import.meta.url, {
      ...buildPluginLoaderJitiOptions(aliasMap),
      tryNative,
    });
    jitiLoaders.set(cacheKey, loader);
    return loader;
  };
}

let loadModule = createModuleLoader();

export function isJavaScriptModulePath(modulePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase());
}

export function resolveCompiledBundledModulePath(modulePath: string): string {
  const compiledDistModulePath = modulePath.replace(
    `${path.sep}dist-runtime${path.sep}`,
    `${path.sep}dist${path.sep}`,
  );
  return compiledDistModulePath !== modulePath && fs.existsSync(compiledDistModulePath)
    ? compiledDistModulePath
    : modulePath;
}

export function resolvePluginModuleCandidates(rootDir: string, specifier: string): string[] {
  const normalizedSpecifier = specifier.replace(/\\/g, "/");
  const resolvedPath = path.resolve(rootDir, normalizedSpecifier);
  const ext = path.extname(resolvedPath);
  if (ext) {
    return [resolvedPath];
  }
  return [
    resolvedPath,
    `${resolvedPath}.ts`,
    `${resolvedPath}.js`,
    `${resolvedPath}.mjs`,
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
  if (process.platform === "win32" && params.shouldTryNativeRequire?.(safePath)) {
    try {
      return nodeRequire(safePath);
    } catch {
      // Fall back to the Jiti loader path when require() cannot handle the entry.
    }
  }
  return loadModule(safePath)(safePath);
}
