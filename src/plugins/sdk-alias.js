import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const STARTUP_ARGV1 = process.argv[1];
export function normalizeJitiAliasTargetPath(targetPath) {
    return process.platform === "win32" ? targetPath.replace(/\\/g, "/") : targetPath;
}
function resolveLoaderModulePath(params = {}) {
    return params.modulePath ?? fileURLToPath(params.moduleUrl ?? import.meta.url);
}
function readPluginSdkPackageJson(packageRoot) {
    try {
        const pkgRaw = fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8");
        return JSON.parse(pkgRaw);
    }
    catch {
        return null;
    }
}
function isSafePluginSdkSubpathSegment(subpath) {
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}
function listPluginSdkSubpathsFromPackageJson(pkg) {
    return Object.keys(pkg.exports ?? {})
        .filter((key) => key.startsWith("./plugin-sdk/"))
        .map((key) => key.slice("./plugin-sdk/".length))
        .filter((subpath) => isSafePluginSdkSubpathSegment(subpath))
        .toSorted();
}
function hasTrustedOpenClawRootIndicator(params) {
    const packageExports = params.packageJson.exports ?? {};
    const hasPluginSdkRootExport = Object.prototype.hasOwnProperty.call(packageExports, "./plugin-sdk");
    if (!hasPluginSdkRootExport) {
        return false;
    }
    const hasCliEntryExport = Object.prototype.hasOwnProperty.call(packageExports, "./cli-entry");
    const hasOpenClawBin = (typeof params.packageJson.bin === "string" &&
        normalizeLowercaseStringOrEmpty(params.packageJson.bin).includes("openclaw")) ||
        (typeof params.packageJson.bin === "object" &&
            params.packageJson.bin !== null &&
            typeof params.packageJson.bin.openclaw === "string");
    const hasOpenClawEntrypoint = fs.existsSync(path.join(params.packageRoot, "openclaw.mjs"));
    return hasCliEntryExport || hasOpenClawBin || hasOpenClawEntrypoint;
}
function readPluginSdkSubpathsFromPackageRoot(packageRoot) {
    const pkg = readPluginSdkPackageJson(packageRoot);
    if (!pkg) {
        return null;
    }
    if (!hasTrustedOpenClawRootIndicator({ packageRoot, packageJson: pkg })) {
        return null;
    }
    const subpaths = listPluginSdkSubpathsFromPackageJson(pkg);
    return subpaths.length > 0 ? subpaths : null;
}
function resolveTrustedOpenClawRootFromArgvHint(params) {
    if (!params.argv1) {
        return null;
    }
    const packageRoot = resolveOpenClawPackageRootSync({
        cwd: params.cwd,
        argv1: params.argv1,
    });
    if (!packageRoot) {
        return null;
    }
    const packageJson = readPluginSdkPackageJson(packageRoot);
    if (!packageJson) {
        return null;
    }
    return hasTrustedOpenClawRootIndicator({ packageRoot, packageJson }) ? packageRoot : null;
}
function findNearestPluginSdkPackageRoot(startDir, maxDepth = 12) {
    let cursor = path.resolve(startDir);
    for (let i = 0; i < maxDepth; i += 1) {
        const subpaths = readPluginSdkSubpathsFromPackageRoot(cursor);
        if (subpaths) {
            return cursor;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            break;
        }
        cursor = parent;
    }
    return null;
}
export function resolveLoaderPackageRoot(params) {
    const cwd = params.cwd ?? path.dirname(params.modulePath);
    const fromModulePath = resolveOpenClawPackageRootSync({ cwd });
    if (fromModulePath) {
        return fromModulePath;
    }
    const argv1 = params.argv1 ?? process.argv[1];
    const moduleUrl = params.moduleUrl ?? (params.modulePath ? undefined : import.meta.url);
    return resolveOpenClawPackageRootSync({
        cwd,
        ...(argv1 ? { argv1 } : {}),
        ...(moduleUrl ? { moduleUrl } : {}),
    });
}
function resolveLoaderPluginSdkPackageRoot(params) {
    const cwd = params.cwd ?? path.dirname(params.modulePath);
    const fromCwd = resolveOpenClawPackageRootSync({ cwd });
    const fromExplicitHints = resolveTrustedOpenClawRootFromArgvHint({ cwd, argv1: params.argv1 }) ??
        (params.moduleUrl
            ? resolveOpenClawPackageRootSync({
                cwd,
                moduleUrl: params.moduleUrl,
            })
            : null);
    return (fromCwd ??
        fromExplicitHints ??
        findNearestPluginSdkPackageRoot(path.dirname(params.modulePath)) ??
        (params.cwd ? findNearestPluginSdkPackageRoot(params.cwd) : null) ??
        findNearestPluginSdkPackageRoot(process.cwd()));
}
export function resolvePluginSdkAliasCandidateOrder(params) {
    if (params.pluginSdkResolution === "dist") {
        return ["dist", "src"];
    }
    if (params.pluginSdkResolution === "src") {
        return ["src", "dist"];
    }
    const normalizedModulePath = params.modulePath.replace(/\\/g, "/");
    const isDistRuntime = normalizedModulePath.includes("/dist/");
    return isDistRuntime || params.isProduction ? ["dist", "src"] : ["src", "dist"];
}
export function listPluginSdkAliasCandidates(params) {
    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
        modulePath: params.modulePath,
        isProduction: process.env.NODE_ENV === "production",
        pluginSdkResolution: params.pluginSdkResolution,
    });
    const packageRoot = resolveLoaderPluginSdkPackageRoot(params);
    if (packageRoot) {
        const candidateMap = {
            src: path.join(packageRoot, "src", "plugin-sdk", params.srcFile),
            dist: path.join(packageRoot, "dist", "plugin-sdk", params.distFile),
        };
        return orderedKinds.map((kind) => candidateMap[kind]);
    }
    let cursor = path.dirname(params.modulePath);
    const candidates = [];
    for (let i = 0; i < 6; i += 1) {
        const candidateMap = {
            src: path.join(cursor, "src", "plugin-sdk", params.srcFile),
            dist: path.join(cursor, "dist", "plugin-sdk", params.distFile),
        };
        for (const kind of orderedKinds) {
            candidates.push(candidateMap[kind]);
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) {
            break;
        }
        cursor = parent;
    }
    return candidates;
}
export function resolvePluginSdkAliasFile(params) {
    try {
        const modulePath = resolveLoaderModulePath(params);
        for (const candidate of listPluginSdkAliasCandidates({
            srcFile: params.srcFile,
            distFile: params.distFile,
            modulePath,
            argv1: params.argv1,
            cwd: params.cwd,
            moduleUrl: params.moduleUrl,
            pluginSdkResolution: params.pluginSdkResolution,
        })) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    catch {
        // ignore
    }
    return null;
}
const cachedPluginSdkExportedSubpaths = new Map();
const cachedPluginSdkScopedAliasMaps = new Map();
const PLUGIN_SDK_PACKAGE_NAMES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"];
const PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS = [
    ".ts",
    ".mts",
    ".js",
    ".mjs",
    ".cts",
    ".cjs",
];
const JS_STATIC_RELATIVE_DEPENDENCY_PATTERN = /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])(\.{1,2}\/[^"']+)["']/g;
function isUsableDistPluginSdkArtifact(candidate) {
    if (!fs.existsSync(candidate)) {
        return false;
    }
    switch (normalizeLowercaseStringOrEmpty(path.extname(candidate))) {
        case ".js":
        case ".mjs":
        case ".cjs":
            break;
        default:
            return true;
    }
    try {
        const source = fs.readFileSync(candidate, "utf-8");
        for (const match of source.matchAll(JS_STATIC_RELATIVE_DEPENDENCY_PATTERN)) {
            const specifier = match[1];
            if (!specifier || fs.existsSync(path.resolve(path.dirname(candidate), specifier))) {
                continue;
            }
            return false;
        }
    }
    catch {
        return false;
    }
    return true;
}
function readPrivateLocalOnlyPluginSdkSubpaths(packageRoot) {
    try {
        const raw = fs.readFileSync(path.join(packageRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"), "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((subpath) => isSafePluginSdkSubpathSegment(subpath));
    }
    catch {
        return [];
    }
}
function shouldIncludePrivateLocalOnlyPluginSdkSubpaths() {
    return process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}
function hasPluginSdkSubpathArtifact(packageRoot, subpath) {
    const distPath = path.join(packageRoot, "dist", "plugin-sdk", `${subpath}.js`);
    if (isUsableDistPluginSdkArtifact(distPath)) {
        return true;
    }
    return PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS.some((ext) => fs.existsSync(path.join(packageRoot, "src", "plugin-sdk", `${subpath}${ext}`)));
}
function listDistPluginSdkArtifactSubpaths(packageRoot) {
    try {
        const distPluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
        return new Set(fs
            .readdirSync(distPluginSdkDir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
            .map((entry) => entry.name.slice(0, -".js".length))
            .filter((subpath) => isSafePluginSdkSubpathSegment(subpath)));
    }
    catch {
        return new Set();
    }
}
function listPrivateLocalOnlyPluginSdkSubpaths(packageRoot) {
    if (!shouldIncludePrivateLocalOnlyPluginSdkSubpaths()) {
        return [];
    }
    return readPrivateLocalOnlyPluginSdkSubpaths(packageRoot).filter((subpath) => hasPluginSdkSubpathArtifact(packageRoot, subpath));
}
export function listPluginSdkExportedSubpaths(params = {}) {
    const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
    const packageRoot = resolveLoaderPluginSdkPackageRoot({
        modulePath,
        argv1: params.argv1,
        moduleUrl: params.moduleUrl,
    });
    if (!packageRoot) {
        return [];
    }
    const cacheKey = `${packageRoot}::privateQa=${shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "1" : "0"}`;
    const cached = cachedPluginSdkExportedSubpaths.get(cacheKey);
    if (cached) {
        return cached;
    }
    const subpaths = [
        ...new Set([
            ...(readPluginSdkSubpathsFromPackageRoot(packageRoot) ?? []),
            ...listPrivateLocalOnlyPluginSdkSubpaths(packageRoot),
        ]),
    ].toSorted();
    cachedPluginSdkExportedSubpaths.set(cacheKey, subpaths);
    return subpaths;
}
export function resolvePluginSdkScopedAliasMap(params = {}) {
    const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
    const packageRoot = resolveLoaderPluginSdkPackageRoot({
        modulePath,
        argv1: params.argv1,
        moduleUrl: params.moduleUrl,
    });
    if (!packageRoot) {
        return {};
    }
    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
        modulePath,
        isProduction: process.env.NODE_ENV === "production",
        pluginSdkResolution: params.pluginSdkResolution,
    });
    const cacheKey = `${packageRoot}::${orderedKinds.join(",")}::privateQa=${shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "1" : "0"}`;
    const cached = cachedPluginSdkScopedAliasMaps.get(cacheKey);
    if (cached) {
        return cached;
    }
    const aliasMap = {};
    const distPluginSdkArtifacts = orderedKinds.includes("dist")
        ? listDistPluginSdkArtifactSubpaths(packageRoot)
        : new Set();
    for (const subpath of listPluginSdkExportedSubpaths({
        modulePath,
        argv1: params.argv1,
        moduleUrl: params.moduleUrl,
        pluginSdkResolution: params.pluginSdkResolution,
    })) {
        for (const kind of orderedKinds) {
            if (kind === "dist") {
                if (!distPluginSdkArtifacts.has(subpath)) {
                    continue;
                }
                const candidate = path.join(packageRoot, "dist", "plugin-sdk", `${subpath}.js`);
                if (isUsableDistPluginSdkArtifact(candidate)) {
                    for (const packageName of PLUGIN_SDK_PACKAGE_NAMES) {
                        aliasMap[`${packageName}/${subpath}`] = candidate;
                    }
                    break;
                }
                continue;
            }
            for (const ext of PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS) {
                const candidate = path.join(packageRoot, "src", "plugin-sdk", `${subpath}${ext}`);
                if (!fs.existsSync(candidate)) {
                    continue;
                }
                for (const packageName of PLUGIN_SDK_PACKAGE_NAMES) {
                    aliasMap[`${packageName}/${subpath}`] = candidate;
                }
                break;
            }
            if (Object.prototype.hasOwnProperty.call(aliasMap, `openclaw/plugin-sdk/${subpath}`)) {
                break;
            }
        }
    }
    cachedPluginSdkScopedAliasMaps.set(cacheKey, aliasMap);
    return aliasMap;
}
export function resolveExtensionApiAlias(params = {}) {
    try {
        const modulePath = resolveLoaderModulePath(params);
        const packageRoot = resolveLoaderPackageRoot({ ...params, modulePath });
        if (!packageRoot) {
            return null;
        }
        const orderedKinds = resolvePluginSdkAliasCandidateOrder({
            modulePath,
            isProduction: process.env.NODE_ENV === "production",
            pluginSdkResolution: params.pluginSdkResolution,
        });
        for (const kind of orderedKinds) {
            if (kind === "dist") {
                const candidate = path.join(packageRoot, "dist", "extensionAPI.js");
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
                continue;
            }
            for (const ext of PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS) {
                const candidate = path.join(packageRoot, "src", `extensionAPI${ext}`);
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }
    catch {
        // ignore
    }
    return null;
}
const MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES = 512;
const JITI_NORMALIZED_ALIAS_SYMBOL = Symbol.for("pathe:normalizedAlias");
const JITI_ALIAS_ROOT_SENTINELS = new Set(["/", "\\", undefined]);
// Memoize loader alias/config by effective resolution context so repeated
// loader setup avoids rebuilding the same filesystem-derived map and cache key.
// Include cwd/env inputs because the fallback root and private QA alias
// surfaces depend on them.
const aliasMapCache = new Map();
const normalizedJitiAliasMapCache = new Map();
const pluginLoaderJitiConfigCache = new Map();
function setBoundedCacheValue(cache, key, value) {
    if (cache.has(key)) {
        cache.delete(key);
    }
    cache.set(key, value);
    while (cache.size > MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (typeof oldestKey !== "string") {
            break;
        }
        cache.delete(oldestKey);
    }
}
function hasJitiNormalizedAliasMarker(aliasMap) {
    return Boolean(aliasMap[JITI_NORMALIZED_ALIAS_SYMBOL]);
}
function createJitiAliasContentCacheKey(aliasMap) {
    return JSON.stringify(Object.entries(aliasMap).toSorted(([left], [right]) => left.localeCompare(right)));
}
function normalizePluginLoaderAliasMapForJiti(aliasMap) {
    if (hasJitiNormalizedAliasMarker(aliasMap)) {
        return aliasMap;
    }
    const cacheKey = createJitiAliasContentCacheKey(aliasMap);
    const cached = normalizedJitiAliasMapCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const normalizedAliasMap = Object.fromEntries(Object.entries(aliasMap).toSorted(([left], [right]) => right.split("/").length - left.split("/").length));
    for (const aliasKey in normalizedAliasMap) {
        for (const candidateKey in normalizedAliasMap) {
            if (candidateKey === aliasKey ||
                aliasKey.startsWith(candidateKey) ||
                !normalizedAliasMap[aliasKey]?.startsWith(candidateKey) ||
                !JITI_ALIAS_ROOT_SENTINELS.has(normalizedAliasMap[aliasKey]?.[candidateKey.length])) {
                continue;
            }
            normalizedAliasMap[aliasKey] =
                normalizedAliasMap[candidateKey] + normalizedAliasMap[aliasKey].slice(candidateKey.length);
        }
    }
    Object.defineProperty(normalizedAliasMap, JITI_NORMALIZED_ALIAS_SYMBOL, {
        value: true,
        enumerable: false,
    });
    setBoundedCacheValue(normalizedJitiAliasMapCache, cacheKey, normalizedAliasMap);
    return normalizedAliasMap;
}
function buildPluginLoaderAliasMapCacheKey(params) {
    return [
        params.modulePath,
        params.argv1 ?? "",
        params.moduleUrl ?? "",
        params.pluginSdkResolution,
        process.cwd(),
        process.env.NODE_ENV === "production" ? "production" : "non-production",
        shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "private-qa" : "public",
    ].join("\0");
}
function buildPluginLoaderJitiConfigCacheKey(params) {
    return [
        buildPluginLoaderAliasMapCacheKey({
            modulePath: params.modulePath,
            argv1: params.argv1,
            moduleUrl: params.moduleUrl,
            pluginSdkResolution: params.pluginSdkResolution ?? "auto",
        }),
        params.preferBuiltDist === true ? "prefer-built-dist" : "default-dist",
    ].join("\0");
}
export function buildPluginLoaderAliasMap(modulePath, argv1 = STARTUP_ARGV1, moduleUrl, pluginSdkResolution = "auto") {
    const cacheKey = buildPluginLoaderAliasMapCacheKey({
        modulePath,
        argv1,
        moduleUrl,
        pluginSdkResolution,
    });
    const cached = aliasMapCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const pluginSdkAlias = resolvePluginSdkAliasFile({
        srcFile: "root-alias.cjs",
        distFile: "root-alias.cjs",
        modulePath,
        argv1,
        moduleUrl,
        pluginSdkResolution,
    });
    const extensionApiAlias = resolveExtensionApiAlias({ modulePath, pluginSdkResolution });
    const result = {
        ...(extensionApiAlias
            ? { "openclaw/extension-api": normalizeJitiAliasTargetPath(extensionApiAlias) }
            : {}),
        ...(pluginSdkAlias
            ? Object.fromEntries(PLUGIN_SDK_PACKAGE_NAMES.map((packageName) => [
                packageName,
                normalizeJitiAliasTargetPath(pluginSdkAlias),
            ]))
            : {}),
        ...Object.fromEntries(Object.entries(resolvePluginSdkScopedAliasMap({ modulePath, argv1, moduleUrl, pluginSdkResolution })).map(([key, value]) => [key, normalizeJitiAliasTargetPath(value)])),
    };
    setBoundedCacheValue(aliasMapCache, cacheKey, result);
    return result;
}
export function resolvePluginRuntimeModulePath(params = {}) {
    try {
        const modulePath = resolveLoaderModulePath(params);
        const orderedKinds = resolvePluginSdkAliasCandidateOrder({
            modulePath,
            isProduction: process.env.NODE_ENV === "production",
            pluginSdkResolution: params.pluginSdkResolution,
        });
        const packageRoot = resolveLoaderPackageRoot({ ...params, modulePath });
        const candidates = packageRoot
            ? orderedKinds.map((kind) => kind === "src"
                ? path.join(packageRoot, "src", "plugins", "runtime", "index.ts")
                : path.join(packageRoot, "dist", "plugins", "runtime", "index.js"))
            : [
                path.join(path.dirname(modulePath), "runtime", "index.ts"),
                path.join(path.dirname(modulePath), "runtime", "index.js"),
            ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    catch {
        // ignore
    }
    return null;
}
export function buildPluginLoaderJitiOptions(aliasMap) {
    const hasAliases = Object.keys(aliasMap).length > 0;
    const jitiAliasMap = hasAliases ? normalizePluginLoaderAliasMapForJiti(aliasMap) : aliasMap;
    return {
        interopDefault: true,
        // Prefer Node's native sync ESM loader for built dist/*.js modules so
        // bundled plugins and plugin-sdk subpaths stay on the canonical module graph.
        tryNative: true,
        extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
        ...(hasAliases
            ? {
                alias: jitiAliasMap,
            }
            : {}),
    };
}
function supportsNativeJitiRuntime() {
    const versions = process.versions;
    return typeof versions.bun !== "string";
}
function isBundledPluginDistModulePath(modulePath) {
    return modulePath.replace(/\\/g, "/").includes("/dist/extensions/");
}
export function shouldPreferNativeJiti(modulePath) {
    if (!supportsNativeJitiRuntime()) {
        return false;
    }
    switch (normalizeLowercaseStringOrEmpty(path.extname(modulePath))) {
        case ".js":
        case ".mjs":
        case ".cjs":
        case ".json":
            return true;
        default:
            return false;
    }
}
export function resolvePluginLoaderJitiTryNative(modulePath, options) {
    if (isBundledPluginDistModulePath(modulePath)) {
        return shouldPreferNativeJiti(modulePath);
    }
    return (shouldPreferNativeJiti(modulePath) ||
        (supportsNativeJitiRuntime() &&
            options?.preferBuiltDist === true &&
            modulePath.includes(`${path.sep}dist${path.sep}`)));
}
export function createPluginLoaderJitiCacheKey(params) {
    return JSON.stringify({
        tryNative: params.tryNative,
        aliasMap: Object.entries(params.aliasMap).toSorted(([left], [right]) => left.localeCompare(right)),
    });
}
export function resolvePluginLoaderJitiConfig(params) {
    const configCacheKey = buildPluginLoaderJitiConfigCacheKey(params);
    const cached = pluginLoaderJitiConfigCache.get(configCacheKey);
    if (cached) {
        return cached;
    }
    const tryNative = resolvePluginLoaderJitiTryNative(params.modulePath, params.preferBuiltDist ? { preferBuiltDist: true } : {});
    const aliasMap = buildPluginLoaderAliasMap(params.modulePath, params.argv1, params.moduleUrl, params.pluginSdkResolution);
    const result = {
        tryNative,
        aliasMap,
        cacheKey: createPluginLoaderJitiCacheKey({
            tryNative,
            aliasMap,
        }),
    };
    setBoundedCacheValue(pluginLoaderJitiConfigCache, configCacheKey, result);
    return result;
}
export function isBundledPluginExtensionPath(params) {
    const normalizedModulePath = path.resolve(params.modulePath);
    const roots = [
        params.bundledPluginsDir ? path.resolve(params.bundledPluginsDir) : null,
        path.join(params.openClawPackageRoot, "extensions"),
        path.join(params.openClawPackageRoot, "dist", "extensions"),
        path.join(params.openClawPackageRoot, "dist-runtime", "extensions"),
    ].filter((root) => typeof root === "string");
    return roots.some((root) => normalizedModulePath === root || normalizedModulePath.startsWith(`${root}${path.sep}`));
}
