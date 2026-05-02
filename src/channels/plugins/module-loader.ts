import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { openBoundaryFileSync } from "../../infra/boundary-file-read.js";
import { isJavaScriptModulePath } from "../../plugins/native-module-require.js";

const nodeRequire = createRequire(import.meta.url);
const SOURCE_MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function hasNativeSourceRequireHook(modulePath: string): boolean {
  const extension = path.extname(modulePath).toLowerCase();
  return (
    SOURCE_MODULE_EXTENSIONS.has(extension) &&
    typeof nodeRequire.extensions?.[extension] === "function"
  );
}

function loadModule(modulePath: string): unknown {
  if (!isJavaScriptModulePath(modulePath) && !hasNativeSourceRequireHook(modulePath)) {
    throw new Error(`channel plugin module must be built JavaScript: ${modulePath}`);
  }
  try {
    return nodeRequire(modulePath);
  } catch (error) {
    throw new Error(`failed to load channel plugin module with native require: ${modulePath}`, {
      cause: error,
    });
  }
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
  return loadModule(safePath);
}
