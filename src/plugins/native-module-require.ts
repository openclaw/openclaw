import fs from "node:fs";
import { createRequire } from "node:module";
import Module from "node:module";
import path from "node:path";

const nodeRequire = createRequire(import.meta.url);
type ResolveFilename = (
  request: string,
  parent: NodeJS.Module | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string;
const moduleWithResolver = Module as typeof Module & {
  _resolveFilename?: ResolveFilename;
};

export function isJavaScriptModulePath(modulePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase());
}

function isMissingTargetModuleError(
  error: { code?: unknown; message?: unknown },
  modulePath: string,
): boolean {
  if (error.code !== "MODULE_NOT_FOUND" || typeof error.message !== "string") {
    return false;
  }
  const firstLine = error.message.split("\n", 1)[0] ?? "";
  return firstLine.includes(`'${modulePath}'`) || firstLine.includes(`"${modulePath}"`);
}

function isSourceTransformFallbackError(error: unknown, modulePath: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  const code = candidate.code;
  return (
    code === "ERR_REQUIRE_ESM" ||
    code === "ERR_REQUIRE_ASYNC_MODULE" ||
    isMissingTargetModuleError(candidate, modulePath)
  );
}

export function tryNativeRequireJavaScriptModule(
  modulePath: string,
  options: {
    allowWindows?: boolean;
    aliasMap?: Record<string, string>;
    fallbackOnMissingDependency?: boolean;
    fallbackOnNativeError?: boolean;
  } = {},
): { ok: true; moduleExport: unknown } | { ok: false } {
  if (process.platform === "win32" && options.allowWindows !== true) {
    return { ok: false };
  }
  if (!isJavaScriptModulePath(modulePath)) {
    return { ok: false };
  }
  try {
    return { ok: true, moduleExport: requireWithOptionalAliases(modulePath, options.aliasMap) };
  } catch (error) {
    const code =
      error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (
      isSourceTransformFallbackError(error, modulePath) ||
      options.fallbackOnNativeError ||
      (options.fallbackOnMissingDependency === true &&
        (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"))
    ) {
      return { ok: false };
    }
    throw error;
  }
}

function requireWithOptionalAliases(
  modulePath: string,
  aliasMap: Record<string, string> | undefined,
): unknown {
  return withNativeRequireAliases(aliasMap, () => nodeRequire(modulePath));
}

// Memoized file-vs-directory probe for alias targets. We need this to decide
// whether to use `dirname(aliasTarget)` (file target) or `aliasTarget` itself
// (directory target) as the base for suffix resolution. A pure `path.extname`
// heuristic is wrong for directories whose last segment contains a dot
// (e.g. `dist/plugin-sdk.v2`), so we prefer a real `statSync` and only fall
// back to the extension check when the target cannot be stat'd.
const aliasTargetIsFileCache = new Map<string, boolean>();
function isFileValuedAliasTarget(aliasTarget: string): boolean {
  const cached = aliasTargetIsFileCache.get(aliasTarget);
  if (cached !== undefined) {
    return cached;
  }
  let isFile: boolean;
  try {
    isFile = fs.statSync(aliasTarget).isFile();
  } catch {
    isFile = path.extname(aliasTarget) !== "";
  }
  aliasTargetIsFileCache.set(aliasTarget, isFile);
  return isFile;
}

function resolveAliasSubpathTarget(params: {
  aliasTarget: string;
  remainder: string;
  parent: NodeJS.Module | undefined;
  isMain: boolean;
  options?: { paths?: string[] };
  originalResolveFilename: ResolveFilename;
}): string | null {
  const { aliasTarget, isMain, options, originalResolveFilename, parent, remainder } = params;
  const basePath = isFileValuedAliasTarget(aliasTarget) ? path.dirname(aliasTarget) : aliasTarget;
  const targetPath = path.resolve(basePath, remainder);
  try {
    return originalResolveFilename(targetPath, parent, isMain, options);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

function resolveNativeRequireAlias(
  request: string,
  aliasMap: Record<string, string>,
  parent: NodeJS.Module | undefined,
  isMain: boolean,
  options: { paths?: string[] } | undefined,
  originalResolveFilename: ResolveFilename,
): string | null {
  const exactTarget = aliasMap[request];
  if (exactTarget) {
    return exactTarget;
  }
  const prefix = Object.keys(aliasMap)
    .filter((key) => request.startsWith(`${key}/`))
    .toSorted((left, right) => right.length - left.length)[0];
  if (!prefix) {
    return null;
  }
  return resolveAliasSubpathTarget({
    aliasTarget: aliasMap[prefix],
    remainder: request.slice(prefix.length + 1),
    parent,
    isMain,
    options,
    originalResolveFilename,
  });
}

export function withNativeRequireAliases<T>(
  aliasMap: Record<string, string> | undefined,
  run: () => T,
): T {
  if (!aliasMap || Object.keys(aliasMap).length === 0 || !moduleWithResolver["_resolveFilename"]) {
    return run();
  }
  const originalResolveFilename = moduleWithResolver["_resolveFilename"];
  moduleWithResolver["_resolveFilename"] = ((request, parent, isMain, options) => {
    const aliasTarget = resolveNativeRequireAlias(
      request,
      aliasMap,
      parent,
      isMain,
      options,
      originalResolveFilename,
    );
    if (aliasTarget) {
      return aliasTarget;
    }
    return originalResolveFilename(request, parent, isMain, options);
  }) satisfies ResolveFilename;
  try {
    return run();
  } finally {
    moduleWithResolver["_resolveFilename"] = originalResolveFilename;
  }
}
