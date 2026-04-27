import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clearAgentHarnesses, listRegisteredAgentHarnesses, restoreRegisteredAgentHarnesses, } from "../agents/harness/registry.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { DEFAULT_MEMORY_DREAMING_PLUGIN_ID, resolveMemoryDreamingConfig, resolveMemoryDreamingPluginConfig, } from "../memory-host-sdk/dreaming.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../shared/string-coerce.js";
import { clearDetachedTaskLifecycleRuntimeRegistration, getDetachedTaskLifecycleRuntimeRegistration, restoreDetachedTaskLifecycleRuntimeRegistration, } from "../tasks/detached-task-runtime-state.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import { buildPluginApi } from "./api-builder.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { clearBundledRuntimeDependencyNodePaths, ensureBundledPluginRuntimeDeps, installBundledRuntimeDeps, resolveBundledRuntimeDependencyInstallRoot, resolveBundledRuntimeDependencyPackageRoot, registerBundledRuntimeDependencyNodePath, } from "./bundled-runtime-deps.js";
import { clearPluginCommands, listRegisteredPluginCommands, restorePluginCommands, } from "./command-registry-state.js";
import { clearCompactionProviders, listRegisteredCompactionProviders, restoreRegisteredCompactionProviders, } from "./compaction-provider.js";
import { applyTestPluginDefaults, createPluginActivationSource, normalizePluginsConfig, resolveEffectiveEnableState, resolveEffectivePluginActivationState, resolveMemorySlotDecision, } from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { getGlobalHookRunner, initializeGlobalHookRunner } from "./hook-runner-global.js";
import { loadPluginInstallRecordsSync } from "./install-ledger-store.js";
import { clearPluginInteractiveHandlers, listPluginInteractiveHandlers, restorePluginInteractiveHandlers, } from "./interactive-registry.js";
import { getCachedPluginJitiLoader } from "./jiti-loader-cache.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { clearMemoryEmbeddingProviders, listRegisteredMemoryEmbeddingProviders, restoreRegisteredMemoryEmbeddingProviders, } from "./memory-embedding-providers.js";
import { clearMemoryPluginState, getMemoryCapabilityRegistration, getMemoryFlushPlanResolver, getMemoryPromptSectionBuilder, getMemoryRuntime, listMemoryCorpusSupplements, listMemoryPromptSupplements, restoreMemoryPluginState, } from "./memory-state.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { isPathInside, safeStatSync } from "./path-safety.js";
import { withProfile } from "./plugin-load-profile.js";
import { createPluginIdScopeSet, hasExplicitPluginIdScope, normalizePluginIdScope, serializePluginIdScope, } from "./plugin-scope.js";
import { createPluginRegistry } from "./registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import { getActivePluginRegistry, getActivePluginRegistryKey, getActivePluginRuntimeSubagentMode, recordImportedPluginId, setActivePluginRegistry, } from "./runtime.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import { buildPluginLoaderAliasMap, buildPluginLoaderJitiOptions, listPluginSdkAliasCandidates, listPluginSdkExportedSubpaths, resolveExtensionApiAlias, resolvePluginSdkAliasCandidateOrder, resolvePluginSdkAliasFile, resolvePluginRuntimeModulePath, resolvePluginSdkScopedAliasMap, normalizeJitiAliasTargetPath, shouldPreferNativeJiti, } from "./sdk-alias.js";
import { hasKind, kindsEqual } from "./slots.js";
const CLI_METADATA_ENTRY_BASENAMES = [
    "cli-metadata.ts",
    "cli-metadata.js",
    "cli-metadata.mjs",
    "cli-metadata.cjs",
];
function resolveDreamingSidecarEngineId(params) {
    const normalizedMemorySlot = normalizeLowercaseStringOrEmpty(params.memorySlot);
    if (!normalizedMemorySlot ||
        normalizedMemorySlot === "none" ||
        normalizedMemorySlot === DEFAULT_MEMORY_DREAMING_PLUGIN_ID) {
        return null;
    }
    const dreamingConfig = resolveMemoryDreamingConfig({
        pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
        cfg: params.cfg,
    });
    return dreamingConfig.enabled ? DEFAULT_MEMORY_DREAMING_PLUGIN_ID : null;
}
export class PluginLoadFailureError extends Error {
    pluginIds;
    registry;
    constructor(registry) {
        const failedPlugins = registry.plugins.filter((entry) => entry.status === "error");
        const summary = failedPlugins
            .map((entry) => `${entry.id}: ${entry.error ?? "unknown plugin load error"}`)
            .join("; ");
        super(`plugin load failed: ${summary}`);
        this.name = "PluginLoadFailureError";
        this.pluginIds = failedPlugins.map((entry) => entry.id);
        this.registry = registry;
    }
}
export class PluginLoadReentryError extends Error {
    cacheKey;
    constructor(cacheKey) {
        super(`plugin load reentry detected for cache key: ${cacheKey}`);
        this.name = "PluginLoadReentryError";
        this.cacheKey = cacheKey;
    }
}
const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;
let pluginRegistryCacheEntryCap = MAX_PLUGIN_REGISTRY_CACHE_ENTRIES;
const registryCache = new Map();
const inFlightPluginRegistryLoads = new Set();
const openAllowlistWarningCache = new Set();
const LAZY_RUNTIME_REFLECTION_KEYS = [
    "version",
    "config",
    "agent",
    "subagent",
    "system",
    "media",
    "tts",
    "stt",
    "channel",
    "events",
    "logging",
    "state",
    "modelAuth",
];
export function clearPluginLoaderCache() {
    registryCache.clear();
    inFlightPluginRegistryLoads.clear();
    openAllowlistWarningCache.clear();
    clearBundledRuntimeDependencyNodePaths();
    bundledRuntimeDependencyJitiAliases.clear();
    clearAgentHarnesses();
    clearPluginCommands();
    clearCompactionProviders();
    clearDetachedTaskLifecycleRuntimeRegistration();
    clearPluginInteractiveHandlers();
    clearMemoryEmbeddingProviders();
    clearMemoryPluginState();
}
const defaultLogger = () => createSubsystemLogger("plugins");
function isPromiseLike(value) {
    return ((typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof value.then === "function");
}
function snapshotPluginRegistry(registry) {
    return {
        arrays: {
            tools: [...registry.tools],
            hooks: [...registry.hooks],
            typedHooks: [...registry.typedHooks],
            channels: [...registry.channels],
            channelSetups: [...registry.channelSetups],
            providers: [...registry.providers],
            cliBackends: [...(registry.cliBackends ?? [])],
            textTransforms: [...registry.textTransforms],
            speechProviders: [...registry.speechProviders],
            realtimeTranscriptionProviders: [...registry.realtimeTranscriptionProviders],
            realtimeVoiceProviders: [...registry.realtimeVoiceProviders],
            mediaUnderstandingProviders: [...registry.mediaUnderstandingProviders],
            imageGenerationProviders: [...registry.imageGenerationProviders],
            videoGenerationProviders: [...registry.videoGenerationProviders],
            musicGenerationProviders: [...registry.musicGenerationProviders],
            webFetchProviders: [...registry.webFetchProviders],
            webSearchProviders: [...registry.webSearchProviders],
            codexAppServerExtensionFactories: [...registry.codexAppServerExtensionFactories],
            agentToolResultMiddlewares: [...registry.agentToolResultMiddlewares],
            memoryEmbeddingProviders: [...registry.memoryEmbeddingProviders],
            agentHarnesses: [...registry.agentHarnesses],
            httpRoutes: [...registry.httpRoutes],
            cliRegistrars: [...registry.cliRegistrars],
            reloads: [...(registry.reloads ?? [])],
            nodeHostCommands: [...(registry.nodeHostCommands ?? [])],
            securityAuditCollectors: [...(registry.securityAuditCollectors ?? [])],
            services: [...registry.services],
            commands: [...registry.commands],
            conversationBindingResolvedHandlers: [...registry.conversationBindingResolvedHandlers],
            diagnostics: [...registry.diagnostics],
        },
        gatewayHandlers: { ...registry.gatewayHandlers },
        gatewayMethodScopes: { ...registry.gatewayMethodScopes },
    };
}
function restorePluginRegistry(registry, snapshot) {
    registry.tools = snapshot.arrays.tools;
    registry.hooks = snapshot.arrays.hooks;
    registry.typedHooks = snapshot.arrays.typedHooks;
    registry.channels = snapshot.arrays.channels;
    registry.channelSetups = snapshot.arrays.channelSetups;
    registry.providers = snapshot.arrays.providers;
    registry.cliBackends = snapshot.arrays.cliBackends;
    registry.textTransforms = snapshot.arrays.textTransforms;
    registry.speechProviders = snapshot.arrays.speechProviders;
    registry.realtimeTranscriptionProviders = snapshot.arrays.realtimeTranscriptionProviders;
    registry.realtimeVoiceProviders = snapshot.arrays.realtimeVoiceProviders;
    registry.mediaUnderstandingProviders = snapshot.arrays.mediaUnderstandingProviders;
    registry.imageGenerationProviders = snapshot.arrays.imageGenerationProviders;
    registry.videoGenerationProviders = snapshot.arrays.videoGenerationProviders;
    registry.musicGenerationProviders = snapshot.arrays.musicGenerationProviders;
    registry.webFetchProviders = snapshot.arrays.webFetchProviders;
    registry.webSearchProviders = snapshot.arrays.webSearchProviders;
    registry.codexAppServerExtensionFactories = snapshot.arrays.codexAppServerExtensionFactories;
    registry.agentToolResultMiddlewares = snapshot.arrays.agentToolResultMiddlewares;
    registry.memoryEmbeddingProviders = snapshot.arrays.memoryEmbeddingProviders;
    registry.agentHarnesses = snapshot.arrays.agentHarnesses;
    registry.httpRoutes = snapshot.arrays.httpRoutes;
    registry.cliRegistrars = snapshot.arrays.cliRegistrars;
    registry.reloads = snapshot.arrays.reloads;
    registry.nodeHostCommands = snapshot.arrays.nodeHostCommands;
    registry.securityAuditCollectors = snapshot.arrays.securityAuditCollectors;
    registry.services = snapshot.arrays.services;
    registry.commands = snapshot.arrays.commands;
    registry.conversationBindingResolvedHandlers =
        snapshot.arrays.conversationBindingResolvedHandlers;
    registry.diagnostics = snapshot.arrays.diagnostics;
    registry.gatewayHandlers = snapshot.gatewayHandlers;
    registry.gatewayMethodScopes = snapshot.gatewayMethodScopes;
}
function createGuardedPluginRegistrationApi(api) {
    let closed = false;
    return {
        api: new Proxy(api, {
            get(target, prop, receiver) {
                const value = Reflect.get(target, prop, receiver);
                if (typeof value !== "function") {
                    return value;
                }
                return (...args) => {
                    if (closed) {
                        return undefined;
                    }
                    return Reflect.apply(value, target, args);
                };
            },
        }),
        close: () => {
            closed = true;
        },
    };
}
function runPluginRegisterSync(register, api) {
    const guarded = createGuardedPluginRegistrationApi(api);
    try {
        const result = register(guarded.api);
        if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => { });
            throw new Error("plugin register must be synchronous");
        }
    }
    finally {
        guarded.close();
    }
}
/**
 * On Windows, the Node.js ESM loader requires absolute paths to be expressed
 * as file:// URLs (e.g. file:///C:/Users/...). Raw drive-letter paths like
 * C:\... are rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME because the loader
 * mistakes the drive letter for an unknown URL scheme.
 *
 * This helper converts Windows absolute import specifiers to file:// URLs and
 * leaves everything else unchanged.
 */
function toSafeImportPath(specifier) {
    if (process.platform !== "win32") {
        return specifier;
    }
    if (specifier.startsWith("file://")) {
        return specifier;
    }
    if (path.win32.isAbsolute(specifier)) {
        const normalizedSpecifier = specifier.replaceAll("\\", "/");
        if (normalizedSpecifier.startsWith("//")) {
            return new URL(`file:${encodeURI(normalizedSpecifier)}`).href;
        }
        return new URL(`file:///${encodeURI(normalizedSpecifier)}`).href;
    }
    return specifier;
}
const bundledRuntimeDependencyJitiAliases = new Map();
function readRuntimeDependencyPackageJson(packageJsonPath) {
    try {
        return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    }
    catch {
        return null;
    }
}
function collectRuntimeDependencyNames(pkg) {
    return [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
    ].toSorted((left, right) => left.localeCompare(right));
}
function resolveRuntimePackageImportTarget(exportsField) {
    if (typeof exportsField === "string") {
        return exportsField;
    }
    if (Array.isArray(exportsField)) {
        for (const entry of exportsField) {
            const resolved = resolveRuntimePackageImportTarget(entry);
            if (resolved) {
                return resolved;
            }
        }
        return null;
    }
    if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
        return null;
    }
    const record = exportsField;
    if (Object.prototype.hasOwnProperty.call(record, ".")) {
        return resolveRuntimePackageImportTarget(record["."]);
    }
    for (const condition of ["import", "node", "default"]) {
        const resolved = resolveRuntimePackageImportTarget(record[condition]);
        if (resolved) {
            return resolved;
        }
    }
    return null;
}
function collectRuntimePackageWildcardImportTargets(dependencyRoot, exportKey, targetPattern) {
    const targets = new Map();
    const wildcardIndex = exportKey.indexOf("*");
    const targetWildcardIndex = targetPattern.indexOf("*");
    if (wildcardIndex === -1 || targetWildcardIndex === -1) {
        return targets;
    }
    const exportPrefix = exportKey.slice(0, wildcardIndex);
    const exportSuffix = exportKey.slice(wildcardIndex + 1);
    const targetPrefix = targetPattern.slice(0, targetWildcardIndex);
    const targetSuffix = targetPattern.slice(targetWildcardIndex + 1);
    const targetBase = path.resolve(dependencyRoot, targetPrefix);
    if (!isPathInside(dependencyRoot, targetBase) || !safeStatSync(targetBase)?.isDirectory()) {
        return targets;
    }
    const stack = [targetBase];
    while (stack.length > 0) {
        const currentDir = stack.pop();
        if (!currentDir) {
            continue;
        }
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            if (!isPathInside(dependencyRoot, entryPath)) {
                continue;
            }
            if (entry.isDirectory()) {
                stack.push(entryPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const relativeTarget = path.relative(targetBase, entryPath).split(path.sep).join("/");
            if (targetSuffix && !relativeTarget.endsWith(targetSuffix)) {
                continue;
            }
            const wildcardValue = targetSuffix
                ? relativeTarget.slice(0, -targetSuffix.length)
                : relativeTarget;
            targets.set(`${exportPrefix}${wildcardValue}${exportSuffix}`, entryPath);
        }
    }
    return targets;
}
function collectRuntimePackageImportTargets(dependencyRoot, pkg) {
    const targets = new Map();
    const exportsField = pkg.exports;
    if (exportsField &&
        typeof exportsField === "object" &&
        !Array.isArray(exportsField) &&
        Object.keys(exportsField).some((key) => key.startsWith("."))) {
        for (const [exportKey, exportValue] of Object.entries(exportsField)) {
            if (!exportKey.startsWith(".")) {
                continue;
            }
            const resolved = resolveRuntimePackageImportTarget(exportValue);
            if (resolved) {
                if (exportKey.includes("*")) {
                    for (const [wildcardExportKey, targetPath] of collectRuntimePackageWildcardImportTargets(dependencyRoot, exportKey, resolved)) {
                        targets.set(wildcardExportKey, targetPath);
                    }
                }
                else {
                    targets.set(exportKey, resolved);
                }
            }
        }
        return targets;
    }
    const rootEntry = resolveRuntimePackageImportTarget(exportsField) ?? pkg.module ?? pkg.main;
    if (rootEntry) {
        targets.set(".", rootEntry);
    }
    return targets;
}
function registerBundledRuntimeDependencyJitiAliases(rootDir) {
    const rootPackageJson = readRuntimeDependencyPackageJson(path.join(rootDir, "package.json"));
    if (!rootPackageJson) {
        return;
    }
    for (const dependencyName of collectRuntimeDependencyNames(rootPackageJson)) {
        const dependencyPackageJsonPath = path.join(rootDir, "node_modules", ...dependencyName.split("/"), "package.json");
        const dependencyPackageJson = readRuntimeDependencyPackageJson(dependencyPackageJsonPath);
        if (!dependencyPackageJson) {
            continue;
        }
        const dependencyRoot = path.dirname(dependencyPackageJsonPath);
        for (const [exportKey, entry] of collectRuntimePackageImportTargets(dependencyRoot, dependencyPackageJson)) {
            if (!entry || entry.startsWith("#")) {
                continue;
            }
            const targetPath = path.resolve(dependencyRoot, entry);
            if (!isPathInside(dependencyRoot, targetPath) || !fs.existsSync(targetPath)) {
                continue;
            }
            const aliasKey = exportKey === "." ? dependencyName : `${dependencyName}${exportKey.slice(1)}`;
            bundledRuntimeDependencyJitiAliases.set(aliasKey, normalizeJitiAliasTargetPath(targetPath));
        }
    }
}
function resolveBundledRuntimeDependencyJitiAliasMap() {
    if (bundledRuntimeDependencyJitiAliases.size === 0) {
        return undefined;
    }
    return Object.fromEntries([...bundledRuntimeDependencyJitiAliases.entries()].toSorted(([left], [right]) => right.length - left.length || left.localeCompare(right)));
}
function createPluginJitiLoader(options) {
    const jitiLoaders = new Map();
    return (modulePath) => {
        const tryNative = shouldPreferNativeJiti(modulePath);
        const runtimeAliasMap = resolveBundledRuntimeDependencyJitiAliasMap();
        return getCachedPluginJitiLoader({
            cache: jitiLoaders,
            modulePath,
            importerUrl: import.meta.url,
            jitiFilename: modulePath,
            ...(runtimeAliasMap
                ? {
                    aliasMap: {
                        ...buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url, options.pluginSdkResolution),
                        ...runtimeAliasMap,
                    },
                }
                : {}),
            pluginSdkResolution: options.pluginSdkResolution,
            // Source .ts runtime shims import sibling ".js" specifiers that only exist
            // after build. Disable native loading for source entries so Jiti rewrites
            // those imports against the source graph, while keeping native dist/*.js
            // loading for the canonical built module graph.
            tryNative,
        });
    };
}
function resolveCanonicalDistRuntimeSource(source) {
    const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
    const index = source.indexOf(marker);
    if (index === -1) {
        return source;
    }
    const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
    return fs.existsSync(candidate) ? candidate : source;
}
function mirrorBundledPluginRuntimeRoot(params) {
    const mirrorParent = prepareBundledPluginRuntimeDistMirror({
        installRoot: params.installRoot,
        pluginRoot: params.pluginRoot,
    });
    const mirrorRoot = path.join(mirrorParent, params.pluginId);
    fs.mkdirSync(params.installRoot, { recursive: true });
    try {
        fs.chmodSync(params.installRoot, 0o755);
    }
    catch {
        // Best-effort only: staged roots may live on filesystems that reject chmod.
    }
    fs.mkdirSync(mirrorParent, { recursive: true });
    try {
        fs.chmodSync(mirrorParent, 0o755);
    }
    catch {
        // Best-effort only: the access check below will surface non-writable dirs.
    }
    fs.accessSync(mirrorParent, fs.constants.W_OK);
    const tempDir = fs.mkdtempSync(path.join(mirrorParent, `.plugin-${params.pluginId}-`));
    const stagedRoot = path.join(tempDir, "plugin");
    try {
        copyBundledPluginRuntimeRoot(params.pluginRoot, stagedRoot);
        fs.rmSync(mirrorRoot, { recursive: true, force: true });
        fs.renameSync(stagedRoot, mirrorRoot);
    }
    finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return mirrorRoot;
}
function prepareBundledPluginRuntimeDistMirror(params) {
    const sourceExtensionsRoot = path.dirname(params.pluginRoot);
    const sourceDistRoot = path.dirname(sourceExtensionsRoot);
    const sourceDistRootName = path.basename(sourceDistRoot);
    const mirrorDistRoot = path.join(params.installRoot, sourceDistRootName);
    const mirrorExtensionsRoot = path.join(mirrorDistRoot, "extensions");
    fs.mkdirSync(mirrorExtensionsRoot, { recursive: true, mode: 0o755 });
    ensureBundledRuntimeDistPackageJson(mirrorDistRoot);
    for (const entry of fs.readdirSync(sourceDistRoot, { withFileTypes: true })) {
        if (entry.name === "extensions") {
            continue;
        }
        const sourcePath = path.join(sourceDistRoot, entry.name);
        const targetPath = path.join(mirrorDistRoot, entry.name);
        if (fs.existsSync(targetPath)) {
            continue;
        }
        try {
            fs.symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "junction" : "file");
        }
        catch {
            if (entry.isDirectory()) {
                copyBundledPluginRuntimeRoot(sourcePath, targetPath);
            }
            else if (entry.isFile()) {
                fs.copyFileSync(sourcePath, targetPath);
            }
        }
    }
    if (sourceDistRootName === "dist-runtime") {
        const sourceCanonicalDistRoot = path.join(path.dirname(sourceDistRoot), "dist");
        const targetCanonicalDistRoot = path.join(params.installRoot, "dist");
        if (fs.existsSync(sourceCanonicalDistRoot)) {
            const targetMatchesSource = fs.existsSync(targetCanonicalDistRoot) &&
                safeRealpathOrResolve(targetCanonicalDistRoot) ===
                    safeRealpathOrResolve(sourceCanonicalDistRoot);
            if (!targetMatchesSource) {
                fs.rmSync(targetCanonicalDistRoot, { recursive: true, force: true });
                try {
                    fs.symlinkSync(sourceCanonicalDistRoot, targetCanonicalDistRoot, "junction");
                }
                catch {
                    copyBundledPluginRuntimeRoot(sourceCanonicalDistRoot, targetCanonicalDistRoot);
                }
            }
        }
    }
    ensureOpenClawPluginSdkAlias(mirrorDistRoot);
    return mirrorExtensionsRoot;
}
function ensureBundledRuntimeDistPackageJson(mirrorDistRoot) {
    const packageJsonPath = path.join(mirrorDistRoot, "package.json");
    if (fs.existsSync(packageJsonPath)) {
        return;
    }
    writeRuntimeJsonFile(packageJsonPath, { type: "module" });
}
function copyBundledPluginRuntimeRoot(sourceRoot, targetRoot) {
    fs.mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
    for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
        if (entry.name === "node_modules") {
            continue;
        }
        const sourcePath = path.join(sourceRoot, entry.name);
        const targetPath = path.join(targetRoot, entry.name);
        if (entry.isDirectory()) {
            copyBundledPluginRuntimeRoot(sourcePath, targetPath);
            continue;
        }
        if (entry.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
            continue;
        }
        if (!entry.isFile()) {
            continue;
        }
        fs.copyFileSync(sourcePath, targetPath);
        try {
            const sourceMode = fs.statSync(sourcePath).mode;
            fs.chmodSync(targetPath, sourceMode | 0o600);
        }
        catch {
            // Readable copied files are enough for plugin loading.
        }
    }
}
function writeRuntimeJsonFile(targetPath, value) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function hasRuntimeDefaultExport(sourcePath) {
    const text = fs.readFileSync(sourcePath, "utf8");
    return /\bexport\s+default\b/u.test(text) || /\bas\s+default\b/u.test(text);
}
function writeRuntimeModuleWrapper(sourcePath, targetPath) {
    const specifier = path.relative(path.dirname(targetPath), sourcePath).replaceAll(path.sep, "/");
    const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
    const defaultForwarder = hasRuntimeDefaultExport(sourcePath)
        ? [
            `import defaultModule from ${JSON.stringify(normalizedSpecifier)};`,
            `let defaultExport = defaultModule;`,
            `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
            `  defaultExport = defaultExport.default;`,
            `}`,
        ]
        : [
            `import * as module from ${JSON.stringify(normalizedSpecifier)};`,
            `let defaultExport = "default" in module ? module.default : module;`,
            `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
            `  defaultExport = defaultExport.default;`,
            `}`,
        ];
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, [
        `export * from ${JSON.stringify(normalizedSpecifier)};`,
        ...defaultForwarder,
        "export { defaultExport as default };",
        "",
    ].join("\n"), "utf8");
}
function ensureOpenClawPluginSdkAlias(distRoot) {
    const pluginSdkDir = path.join(distRoot, "plugin-sdk");
    if (!fs.existsSync(pluginSdkDir)) {
        return;
    }
    const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
    const pluginSdkAliasDir = path.join(aliasDir, "plugin-sdk");
    writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
        name: "openclaw",
        type: "module",
        exports: {
            "./plugin-sdk": "./plugin-sdk/index.js",
            "./plugin-sdk/*": "./plugin-sdk/*.js",
        },
    });
    try {
        if (fs.existsSync(pluginSdkAliasDir) && !fs.lstatSync(pluginSdkAliasDir).isDirectory()) {
            fs.rmSync(pluginSdkAliasDir, { recursive: true, force: true });
        }
    }
    catch {
        // Another process may be creating the alias at the same time; mkdir/write
        // below will either converge or surface the real filesystem error.
    }
    fs.mkdirSync(pluginSdkAliasDir, { recursive: true });
    for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name) !== ".js") {
            continue;
        }
        writeRuntimeModuleWrapper(path.join(pluginSdkDir, entry.name), path.join(pluginSdkAliasDir, entry.name));
    }
}
function remapBundledPluginRuntimePath(params) {
    if (!params.source) {
        return undefined;
    }
    const relative = path.relative(params.pluginRoot, params.source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return params.source;
    }
    return path.join(params.mirroredRoot, relative);
}
export const __testing = {
    buildPluginLoaderJitiOptions,
    buildPluginLoaderAliasMap,
    listPluginSdkAliasCandidates,
    listPluginSdkExportedSubpaths,
    resolveExtensionApiAlias,
    resolvePluginSdkScopedAliasMap,
    resolvePluginSdkAliasCandidateOrder,
    resolvePluginSdkAliasFile,
    resolvePluginRuntimeModulePath,
    ensureOpenClawPluginSdkAlias,
    shouldLoadChannelPluginInSetupRuntime,
    shouldPreferNativeJiti,
    toSafeImportPath,
    getCompatibleActivePluginRegistry,
    resolvePluginLoadCacheContext,
    get maxPluginRegistryCacheEntries() {
        return pluginRegistryCacheEntryCap;
    },
    setMaxPluginRegistryCacheEntriesForTest(value) {
        pluginRegistryCacheEntryCap =
            typeof value === "number" && Number.isFinite(value) && value > 0
                ? Math.max(1, Math.floor(value))
                : MAX_PLUGIN_REGISTRY_CACHE_ENTRIES;
    },
};
function getCachedPluginRegistry(cacheKey) {
    const cached = registryCache.get(cacheKey);
    if (!cached) {
        return undefined;
    }
    // Refresh insertion order so frequently reused registries survive eviction.
    registryCache.delete(cacheKey);
    registryCache.set(cacheKey, cached);
    return cached;
}
function setCachedPluginRegistry(cacheKey, state) {
    if (registryCache.has(cacheKey)) {
        registryCache.delete(cacheKey);
    }
    registryCache.set(cacheKey, state);
    while (registryCache.size > pluginRegistryCacheEntryCap) {
        const oldestKey = registryCache.keys().next().value;
        if (!oldestKey) {
            break;
        }
        registryCache.delete(oldestKey);
    }
}
function buildCacheKey(params) {
    const { roots, loadPaths } = resolvePluginCacheInputs({
        workspaceDir: params.workspaceDir,
        loadPaths: params.plugins.loadPaths,
        env: params.env,
    });
    const installs = Object.fromEntries(Object.entries(params.installs ?? {}).map(([pluginId, install]) => [
        pluginId,
        {
            ...install,
            installPath: typeof install.installPath === "string"
                ? resolveUserPath(install.installPath, params.env)
                : install.installPath,
            sourcePath: typeof install.sourcePath === "string"
                ? resolveUserPath(install.sourcePath, params.env)
                : install.sourcePath,
        },
    ]));
    const scopeKey = serializePluginIdScope(params.onlyPluginIds);
    const setupOnlyKey = params.includeSetupOnlyChannelPlugins === true ? "setup-only" : "runtime";
    const setupOnlyModeKey = params.forceSetupOnlyChannelPlugins === true ? "force-setup" : "normal-setup";
    const setupOnlyRequirementKey = params.requireSetupEntryForSetupOnlyChannelPlugins === true
        ? "require-setup-entry"
        : "allow-full-fallback";
    const startupChannelMode = params.preferSetupRuntimeForChannelPlugins === true ? "prefer-setup" : "full";
    const moduleLoadMode = params.loadModules === false ? "manifest-only" : "load-modules";
    const bundledRuntimeDepsMode = params.installBundledRuntimeDeps === false ? "skip-runtime-deps" : "install-runtime-deps";
    const runtimeSubagentMode = params.runtimeSubagentMode ?? "default";
    const gatewayMethodsKey = JSON.stringify(params.coreGatewayMethodNames ?? []);
    const activationMode = params.activate === false ? "snapshot" : "active";
    return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
        ...params.plugins,
        installs,
        loadPaths,
        activationMetadataKey: params.activationMetadataKey ?? "",
    })}::${scopeKey}::${setupOnlyKey}::${setupOnlyModeKey}::${setupOnlyRequirementKey}::${startupChannelMode}::${moduleLoadMode}::${bundledRuntimeDepsMode}::${runtimeSubagentMode}::${params.pluginSdkResolution ?? "auto"}::${gatewayMethodsKey}::${activationMode}`;
}
function matchesScopedPluginRequest(params) {
    const scopedIds = params.onlyPluginIdSet;
    if (!scopedIds) {
        return true;
    }
    return scopedIds.has(params.pluginId);
}
function resolveRuntimeSubagentMode(runtimeOptions) {
    if (runtimeOptions?.allowGatewaySubagentBinding === true) {
        return "gateway-bindable";
    }
    if (runtimeOptions?.subagent) {
        return "explicit";
    }
    return "default";
}
function buildActivationMetadataHash(params) {
    const enabledSourceChannels = Object.entries(params.activationSource.rootConfig?.channels ?? {})
        .filter(([, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return false;
        }
        return value.enabled === true;
    })
        .map(([channelId]) => channelId)
        .toSorted((left, right) => left.localeCompare(right));
    const pluginEntryStates = Object.entries(params.activationSource.plugins.entries)
        .map(([pluginId, entry]) => [pluginId, entry?.enabled ?? null])
        .toSorted(([left], [right]) => left.localeCompare(right));
    const autoEnableReasonEntries = Object.entries(params.autoEnabledReasons)
        .map(([pluginId, reasons]) => [pluginId, [...reasons]])
        .toSorted(([left], [right]) => left.localeCompare(right));
    return createHash("sha256")
        .update(JSON.stringify({
        enabled: params.activationSource.plugins.enabled,
        allow: params.activationSource.plugins.allow,
        deny: params.activationSource.plugins.deny,
        memorySlot: params.activationSource.plugins.slots.memory,
        entries: pluginEntryStates,
        enabledChannels: enabledSourceChannels,
        autoEnabledReasons: autoEnableReasonEntries,
    }))
        .digest("hex");
}
function hasExplicitCompatibilityInputs(options) {
    return (options.config !== undefined ||
        options.activationSourceConfig !== undefined ||
        options.autoEnabledReasons !== undefined ||
        options.workspaceDir !== undefined ||
        options.env !== undefined ||
        hasExplicitPluginIdScope(options.onlyPluginIds) ||
        options.runtimeOptions !== undefined ||
        options.pluginSdkResolution !== undefined ||
        options.coreGatewayHandlers !== undefined ||
        options.includeSetupOnlyChannelPlugins === true ||
        options.forceSetupOnlyChannelPlugins === true ||
        options.requireSetupEntryForSetupOnlyChannelPlugins === true ||
        options.preferSetupRuntimeForChannelPlugins === true ||
        options.installBundledRuntimeDeps === false ||
        options.loadModules === false);
}
/**
 * Convert loader intent into explicit behavior flags.
 *
 * Registration modes are plugin-facing labels; this plan is the internal source
 * of truth for which entrypoint to load and which activation-only policies run.
 */
function resolvePluginRegistrationPlan(params) {
    if (params.canLoadScopedSetupOnlyChannelPlugin) {
        return {
            mode: "setup-only",
            loadSetupEntry: true,
            loadSetupRuntimeEntry: false,
            runRuntimeCapabilityPolicy: false,
            runFullActivationOnlyRegistrations: false,
        };
    }
    if (params.scopedSetupOnlyChannelPluginRequested &&
        params.requireSetupEntryForSetupOnlyChannelPlugins) {
        return null;
    }
    if (!params.enableStateEnabled) {
        return null;
    }
    const loadSetupRuntimeEntry = params.shouldLoadModules &&
        !params.validateOnly &&
        shouldLoadChannelPluginInSetupRuntime({
            manifestChannels: params.manifestRecord.channels,
            setupSource: params.manifestRecord.setupSource,
            startupDeferConfiguredChannelFullLoadUntilAfterListen: params.manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
            cfg: params.cfg,
            env: params.env,
            preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
        });
    if (loadSetupRuntimeEntry) {
        return {
            mode: "setup-runtime",
            loadSetupEntry: true,
            loadSetupRuntimeEntry: true,
            runRuntimeCapabilityPolicy: false,
            runFullActivationOnlyRegistrations: false,
        };
    }
    const mode = params.shouldActivate ? "full" : "discovery";
    return {
        mode,
        loadSetupEntry: false,
        loadSetupRuntimeEntry: false,
        runRuntimeCapabilityPolicy: true,
        runFullActivationOnlyRegistrations: mode === "full",
    };
}
function resolvePluginLoadCacheContext(options = {}) {
    const env = options.env ?? process.env;
    const cfg = applyTestPluginDefaults(options.config ?? {}, env);
    const activationSourceConfig = resolvePluginActivationSourceConfig({
        config: options.config,
        activationSourceConfig: options.activationSourceConfig,
    });
    const normalized = normalizePluginsConfig(cfg.plugins);
    const activationSource = createPluginActivationSource({
        config: activationSourceConfig,
    });
    const trustNormalized = mergeTrustPluginConfigFromActivationSource({
        normalized,
        activationSource,
    });
    const onlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
    const includeSetupOnlyChannelPlugins = options.includeSetupOnlyChannelPlugins === true;
    const forceSetupOnlyChannelPlugins = options.forceSetupOnlyChannelPlugins === true;
    const requireSetupEntryForSetupOnlyChannelPlugins = options.requireSetupEntryForSetupOnlyChannelPlugins === true;
    const preferSetupRuntimeForChannelPlugins = options.preferSetupRuntimeForChannelPlugins === true;
    const shouldInstallBundledRuntimeDeps = options.installBundledRuntimeDeps !== false;
    const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
    const coreGatewayMethodNames = Object.keys(options.coreGatewayHandlers ?? {}).toSorted();
    const installRecords = loadPluginInstallRecordsSync({ config: cfg, env });
    const cacheKey = buildCacheKey({
        workspaceDir: options.workspaceDir,
        plugins: trustNormalized,
        activationMetadataKey: buildActivationMetadataHash({
            activationSource,
            autoEnabledReasons: options.autoEnabledReasons ?? {},
        }),
        installs: installRecords,
        env,
        onlyPluginIds,
        includeSetupOnlyChannelPlugins,
        forceSetupOnlyChannelPlugins,
        requireSetupEntryForSetupOnlyChannelPlugins,
        preferSetupRuntimeForChannelPlugins,
        loadModules: options.loadModules,
        installBundledRuntimeDeps: options.installBundledRuntimeDeps,
        runtimeSubagentMode,
        pluginSdkResolution: options.pluginSdkResolution,
        coreGatewayMethodNames,
        activate: options.activate,
    });
    return {
        env,
        cfg,
        normalized: trustNormalized,
        activationSourceConfig,
        activationSource,
        autoEnabledReasons: options.autoEnabledReasons ?? {},
        onlyPluginIds,
        includeSetupOnlyChannelPlugins,
        forceSetupOnlyChannelPlugins,
        requireSetupEntryForSetupOnlyChannelPlugins,
        preferSetupRuntimeForChannelPlugins,
        shouldActivate: options.activate !== false,
        shouldLoadModules: options.loadModules !== false,
        shouldInstallBundledRuntimeDeps,
        runtimeSubagentMode,
        cacheKey,
    };
}
function mergeTrustPluginConfigFromActivationSource(params) {
    const source = params.activationSource.plugins;
    const allow = mergePluginTrustList(params.normalized.allow, source.allow);
    const deny = mergePluginTrustList(params.normalized.deny, source.deny);
    const loadPaths = mergePluginTrustList(params.normalized.loadPaths, source.loadPaths);
    if (allow === params.normalized.allow &&
        deny === params.normalized.deny &&
        loadPaths === params.normalized.loadPaths) {
        return params.normalized;
    }
    return {
        ...params.normalized,
        allow,
        deny,
        loadPaths,
    };
}
function mergePluginTrustList(runtimeList, sourceList) {
    if (sourceList.length === 0) {
        return runtimeList;
    }
    const merged = [...runtimeList];
    const seen = new Set(merged);
    for (const entry of sourceList) {
        if (!seen.has(entry)) {
            merged.push(entry);
            seen.add(entry);
        }
    }
    return merged.length === runtimeList.length ? runtimeList : merged;
}
function getCompatibleActivePluginRegistry(options = {}) {
    const activeRegistry = getActivePluginRegistry() ?? undefined;
    if (!activeRegistry) {
        return undefined;
    }
    if (!hasExplicitCompatibilityInputs(options)) {
        return activeRegistry;
    }
    const activeCacheKey = getActivePluginRegistryKey();
    if (!activeCacheKey) {
        return undefined;
    }
    const loadContext = resolvePluginLoadCacheContext(options);
    if (loadContext.cacheKey === activeCacheKey) {
        return activeRegistry;
    }
    if (!loadContext.shouldActivate) {
        const activatingCacheKey = resolvePluginLoadCacheContext({
            ...options,
            activate: true,
        }).cacheKey;
        if (activatingCacheKey === activeCacheKey) {
            return activeRegistry;
        }
    }
    if (loadContext.runtimeSubagentMode === "default" &&
        getActivePluginRuntimeSubagentMode() === "gateway-bindable") {
        const gatewayBindableCacheKey = resolvePluginLoadCacheContext({
            ...options,
            runtimeOptions: {
                ...options.runtimeOptions,
                allowGatewaySubagentBinding: true,
            },
        }).cacheKey;
        if (gatewayBindableCacheKey === activeCacheKey) {
            return activeRegistry;
        }
        if (!loadContext.shouldActivate) {
            const activatingGatewayBindableCacheKey = resolvePluginLoadCacheContext({
                ...options,
                activate: true,
                runtimeOptions: {
                    ...options.runtimeOptions,
                    allowGatewaySubagentBinding: true,
                },
            }).cacheKey;
            if (activatingGatewayBindableCacheKey === activeCacheKey) {
                return activeRegistry;
            }
        }
    }
    return undefined;
}
export function resolveRuntimePluginRegistry(options) {
    if (!options || !hasExplicitCompatibilityInputs(options)) {
        return getCompatibleActivePluginRegistry();
    }
    const compatible = getCompatibleActivePluginRegistry(options);
    if (compatible) {
        return compatible;
    }
    // Helper/runtime callers should not recurse into the same snapshot load while
    // plugin registration is still in flight. Let direct loadOpenClawPlugins(...)
    // callers surface the hard error instead.
    if (isPluginRegistryLoadInFlight(options)) {
        return undefined;
    }
    return loadOpenClawPlugins(options);
}
export function resolvePluginRegistryLoadCacheKey(options = {}) {
    return resolvePluginLoadCacheContext(options).cacheKey;
}
export function isPluginRegistryLoadInFlight(options = {}) {
    return inFlightPluginRegistryLoads.has(resolvePluginRegistryLoadCacheKey(options));
}
export function resolveCompatibleRuntimePluginRegistry(options) {
    // Check whether the active runtime registry is already compatible with these
    // load options. Unlike resolveRuntimePluginRegistry, this never triggers a
    // fresh plugin load on cache miss.
    return getCompatibleActivePluginRegistry(options);
}
function validatePluginConfig(params) {
    const schema = params.schema;
    if (!schema) {
        return { ok: true, value: params.value };
    }
    const cacheKey = params.cacheKey ?? JSON.stringify(schema);
    const result = validateJsonSchemaValue({
        schema,
        cacheKey,
        value: params.value ?? {},
        applyDefaults: true,
    });
    if (result.ok) {
        return { ok: true, value: result.value };
    }
    return { ok: false, errors: result.errors.map((error) => error.text) };
}
function resolvePluginModuleExport(moduleExport) {
    const seen = new Set();
    const candidates = [unwrapDefaultModuleExport(moduleExport), moduleExport];
    for (let index = 0; index < candidates.length && index < 12; index += 1) {
        const resolved = candidates[index];
        if (seen.has(resolved)) {
            continue;
        }
        seen.add(resolved);
        if (typeof resolved === "function") {
            return {
                register: resolved,
            };
        }
        if (resolved && typeof resolved === "object") {
            const def = resolved;
            const register = def.register ?? def.activate;
            if (typeof register === "function") {
                return { definition: def, register };
            }
            for (const key of ["default", "module"]) {
                if (key in def) {
                    candidates.push(def[key]);
                }
            }
        }
    }
    const resolved = candidates[0];
    if (typeof resolved === "function") {
        return {
            register: resolved,
        };
    }
    if (resolved && typeof resolved === "object") {
        const def = resolved;
        const register = def.register ?? def.activate;
        return { definition: def, register };
    }
    return {};
}
function isPluginLoadDebugEnabled(env) {
    const normalized = normalizeLowercaseStringOrEmpty(env.OPENCLAW_PLUGIN_LOAD_DEBUG);
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function describePluginModuleExportShape(value, label = "export", seen = new Set()) {
    if (value === null) {
        return [`${label}:null`];
    }
    if (typeof value !== "object") {
        return [`${label}:${typeof value}`];
    }
    if (seen.has(value)) {
        return [`${label}:circular`];
    }
    seen.add(value);
    const record = value;
    const keys = Object.keys(record).toSorted();
    const visibleKeys = keys.slice(0, 8);
    const extraCount = keys.length - visibleKeys.length;
    const keySummary = visibleKeys.length > 0
        ? `${visibleKeys.join(",")}${extraCount > 0 ? `,+${extraCount}` : ""}`
        : "none";
    const details = [`${label}:object keys=${keySummary}`];
    for (const key of ["default", "module", "register", "activate"]) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
            details.push(...describePluginModuleExportShape(record[key], `${label}.${key}`, seen));
        }
    }
    return details;
}
function formatMissingPluginRegisterError(moduleExport, env) {
    const message = "plugin export missing register/activate";
    if (!isPluginLoadDebugEnabled(env)) {
        return message;
    }
    return `${message} (module shape: ${describePluginModuleExportShape(moduleExport).join("; ")})`;
}
function mergeChannelPluginSection(baseValue, overrideValue) {
    if (baseValue &&
        overrideValue &&
        typeof baseValue === "object" &&
        typeof overrideValue === "object") {
        const merged = {
            ...baseValue,
        };
        for (const [key, value] of Object.entries(overrideValue)) {
            if (value !== undefined) {
                merged[key] = value;
            }
        }
        return {
            ...merged,
        };
    }
    return overrideValue ?? baseValue;
}
function mergeSetupRuntimeChannelPlugin(runtimePlugin, setupPlugin) {
    return {
        ...runtimePlugin,
        ...setupPlugin,
        meta: mergeChannelPluginSection(runtimePlugin.meta, setupPlugin.meta),
        capabilities: mergeChannelPluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
        commands: mergeChannelPluginSection(runtimePlugin.commands, setupPlugin.commands),
        doctor: mergeChannelPluginSection(runtimePlugin.doctor, setupPlugin.doctor),
        reload: mergeChannelPluginSection(runtimePlugin.reload, setupPlugin.reload),
        config: mergeChannelPluginSection(runtimePlugin.config, setupPlugin.config),
        setup: mergeChannelPluginSection(runtimePlugin.setup, setupPlugin.setup),
        messaging: mergeChannelPluginSection(runtimePlugin.messaging, setupPlugin.messaging),
        actions: mergeChannelPluginSection(runtimePlugin.actions, setupPlugin.actions),
        secrets: mergeChannelPluginSection(runtimePlugin.secrets, setupPlugin.secrets),
    };
}
function resolveBundledRuntimeChannelRegistration(moduleExport) {
    const resolved = unwrapDefaultModuleExport(moduleExport);
    if (!resolved || typeof resolved !== "object") {
        return {};
    }
    const entryRecord = resolved;
    if (entryRecord.kind !== "bundled-channel-entry" ||
        typeof entryRecord.id !== "string" ||
        typeof entryRecord.loadChannelPlugin !== "function") {
        return {};
    }
    return {
        id: entryRecord.id,
        loadChannelPlugin: entryRecord.loadChannelPlugin,
        ...(typeof entryRecord.loadChannelSecrets === "function"
            ? {
                loadChannelSecrets: entryRecord.loadChannelSecrets,
            }
            : {}),
        ...(typeof entryRecord.setChannelRuntime === "function"
            ? {
                setChannelRuntime: entryRecord.setChannelRuntime,
            }
            : {}),
    };
}
function loadBundledRuntimeChannelPlugin(params) {
    if (typeof params.registration.loadChannelPlugin !== "function") {
        return {};
    }
    try {
        const loadedPlugin = params.registration.loadChannelPlugin();
        const loadedSecrets = params.registration.loadChannelSecrets?.();
        if (!loadedPlugin || typeof loadedPlugin !== "object") {
            return {};
        }
        const mergedSecrets = mergeChannelPluginSection(loadedPlugin.secrets, loadedSecrets);
        return {
            plugin: {
                ...loadedPlugin,
                ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
            },
        };
    }
    catch (err) {
        return { loadError: err };
    }
}
function resolveSetupChannelRegistration(moduleExport, params = {}) {
    const resolved = unwrapDefaultModuleExport(moduleExport);
    if (!resolved || typeof resolved !== "object") {
        return {};
    }
    const setupEntryRecord = resolved;
    if (setupEntryRecord.kind === "bundled-channel-setup-entry" &&
        typeof setupEntryRecord.loadSetupPlugin === "function") {
        try {
            const setupLoadOptions = params.installRuntimeDeps === false ? { installRuntimeDeps: false } : undefined;
            const loadedPlugin = setupEntryRecord.loadSetupPlugin(setupLoadOptions);
            const loadedSecrets = typeof setupEntryRecord.loadSetupSecrets === "function"
                ? setupEntryRecord.loadSetupSecrets(setupLoadOptions)
                : undefined;
            if (loadedPlugin && typeof loadedPlugin === "object") {
                const mergedSecrets = mergeChannelPluginSection(loadedPlugin.secrets, loadedSecrets);
                return {
                    plugin: {
                        ...loadedPlugin,
                        ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
                    },
                    usesBundledSetupContract: true,
                    ...(typeof setupEntryRecord.setChannelRuntime === "function"
                        ? {
                            setChannelRuntime: setupEntryRecord.setChannelRuntime,
                        }
                        : {}),
                };
            }
        }
        catch (err) {
            return { loadError: err };
        }
    }
    const setup = resolved;
    if (!setup.plugin || typeof setup.plugin !== "object") {
        return {};
    }
    return {
        plugin: setup.plugin,
    };
}
function shouldLoadChannelPluginInSetupRuntime(params) {
    if (!params.setupSource || params.manifestChannels.length === 0) {
        return false;
    }
    if (params.preferSetupRuntimeForChannelPlugins &&
        params.startupDeferConfiguredChannelFullLoadUntilAfterListen === true) {
        return true;
    }
    return !params.manifestChannels.some((channelId) => isChannelConfigured(params.cfg, channelId, params.env));
}
function channelPluginIdBelongsToManifest(params) {
    if (!params.channelId) {
        return true;
    }
    return params.channelId === params.pluginId || params.manifestChannels.includes(params.channelId);
}
function createPluginRecord(params) {
    return {
        id: params.id,
        name: params.name ?? params.id,
        description: params.description,
        version: params.version,
        format: params.format ?? "openclaw",
        bundleFormat: params.bundleFormat,
        bundleCapabilities: params.bundleCapabilities,
        source: params.source,
        rootDir: params.rootDir,
        origin: params.origin,
        workspaceDir: params.workspaceDir,
        enabled: params.enabled,
        explicitlyEnabled: params.activationState?.explicitlyEnabled,
        activated: params.activationState?.activated,
        activationSource: params.activationState?.source,
        activationReason: params.activationState?.reason,
        status: params.enabled ? "loaded" : "disabled",
        toolNames: [],
        hookNames: [],
        channelIds: [],
        cliBackendIds: [],
        providerIds: [],
        speechProviderIds: [],
        realtimeTranscriptionProviderIds: [],
        realtimeVoiceProviderIds: [],
        mediaUnderstandingProviderIds: [],
        imageGenerationProviderIds: [],
        videoGenerationProviderIds: [],
        musicGenerationProviderIds: [],
        webFetchProviderIds: [],
        webSearchProviderIds: [],
        contextEngineIds: [],
        memoryEmbeddingProviderIds: [],
        agentHarnessIds: [],
        gatewayMethods: [],
        cliCommands: [],
        services: [],
        gatewayDiscoveryServiceIds: [],
        commands: [],
        httpRoutes: 0,
        hookCount: 0,
        configSchema: params.configSchema,
        configUiHints: undefined,
        configJsonSchema: undefined,
        contracts: params.contracts,
    };
}
function markPluginActivationDisabled(record, reason) {
    record.activated = false;
    record.activationSource = "disabled";
    record.activationReason = reason;
}
function formatAutoEnabledActivationReason(reasons) {
    if (!reasons || reasons.length === 0) {
        return undefined;
    }
    return reasons.join("; ");
}
function recordPluginError(params) {
    const errorText = process.env.OPENCLAW_PLUGIN_LOADER_DEBUG_STACKS === "1" &&
        params.error instanceof Error &&
        typeof params.error.stack === "string"
        ? params.error.stack
        : String(params.error);
    const deprecatedApiHint = errorText.includes("api.registerHttpHandler") && errorText.includes("is not a function")
        ? "deprecated api.registerHttpHandler(...) was removed; use api.registerHttpRoute(...) for plugin-owned routes or registerPluginHttpRoute(...) for dynamic lifecycle routes"
        : null;
    const displayError = deprecatedApiHint ? `${deprecatedApiHint} (${errorText})` : errorText;
    params.logger.error(`${params.logPrefix}${displayError}`);
    params.record.status = "error";
    params.record.error = displayError;
    params.record.failedAt = new Date();
    params.record.failurePhase = params.phase;
    params.registry.plugins.push(params.record);
    params.seenIds.set(params.pluginId, params.origin);
    params.registry.diagnostics.push({
        level: "error",
        pluginId: params.record.id,
        source: params.record.source,
        message: `${params.diagnosticMessagePrefix}${displayError}`,
    });
}
function formatPluginFailureSummary(failedPlugins) {
    const grouped = new Map();
    for (const plugin of failedPlugins) {
        const phase = plugin.failurePhase ?? "load";
        const ids = grouped.get(phase);
        if (ids) {
            ids.push(plugin.id);
            continue;
        }
        grouped.set(phase, [plugin.id]);
    }
    return [...grouped.entries()].map(([phase, ids]) => `${phase}: ${ids.join(", ")}`).join("; ");
}
function pushDiagnostics(diagnostics, append) {
    diagnostics.push(...append);
}
function maybeThrowOnPluginLoadError(registry, throwOnLoadError) {
    if (!throwOnLoadError) {
        return;
    }
    if (!registry.plugins.some((entry) => entry.status === "error")) {
        return;
    }
    throw new PluginLoadFailureError(registry);
}
function createPathMatcher() {
    return { exact: new Set(), dirs: [] };
}
function addPathToMatcher(matcher, rawPath, env = process.env) {
    const trimmed = rawPath.trim();
    if (!trimmed) {
        return;
    }
    const resolved = resolveUserPath(trimmed, env);
    if (!resolved) {
        return;
    }
    if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
        return;
    }
    const stat = safeStatSync(resolved);
    if (stat?.isDirectory()) {
        matcher.dirs.push(resolved);
        return;
    }
    matcher.exact.add(resolved);
}
function matchesPathMatcher(matcher, sourcePath) {
    if (matcher.exact.has(sourcePath)) {
        return true;
    }
    return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}
function buildProvenanceIndex(params) {
    const loadPathMatcher = createPathMatcher();
    for (const loadPath of params.normalizedLoadPaths) {
        addPathToMatcher(loadPathMatcher, loadPath, params.env);
    }
    const installRules = new Map();
    const installs = loadPluginInstallRecordsSync({
        config: params.config,
        env: params.env,
    });
    for (const [pluginId, install] of Object.entries(installs)) {
        const rule = {
            trackedWithoutPaths: false,
            matcher: createPathMatcher(),
        };
        const trackedPaths = [install.installPath, install.sourcePath]
            .map((entry) => normalizeOptionalString(entry))
            .filter((entry) => Boolean(entry));
        if (trackedPaths.length === 0) {
            rule.trackedWithoutPaths = true;
        }
        else {
            for (const trackedPath of trackedPaths) {
                addPathToMatcher(rule.matcher, trackedPath, params.env);
            }
        }
        installRules.set(pluginId, rule);
    }
    return { loadPathMatcher, installRules };
}
function isTrackedByProvenance(params) {
    const sourcePath = resolveUserPath(params.source, params.env);
    const installRule = params.index.installRules.get(params.pluginId);
    if (installRule) {
        if (installRule.trackedWithoutPaths) {
            return true;
        }
        if (matchesPathMatcher(installRule.matcher, sourcePath)) {
            return true;
        }
    }
    return matchesPathMatcher(params.index.loadPathMatcher, sourcePath);
}
function matchesExplicitInstallRule(params) {
    const sourcePath = resolveUserPath(params.source, params.env);
    const installRule = params.index.installRules.get(params.pluginId);
    if (!installRule || installRule.trackedWithoutPaths) {
        return false;
    }
    return matchesPathMatcher(installRule.matcher, sourcePath);
}
function resolveCandidateDuplicateRank(params) {
    const manifestRecord = params.manifestByRoot.get(params.candidate.rootDir);
    const pluginId = manifestRecord?.id;
    const isExplicitInstall = params.candidate.origin === "global" &&
        pluginId !== undefined &&
        matchesExplicitInstallRule({
            pluginId,
            source: params.candidate.source,
            index: params.provenance,
            env: params.env,
        });
    if (params.candidate.origin === "config") {
        return 0;
    }
    if (params.candidate.origin === "global" && isExplicitInstall) {
        return 1;
    }
    if (params.candidate.origin === "bundled") {
        // Bundled plugin ids stay reserved unless the operator configured an override.
        return 2;
    }
    if (params.candidate.origin === "workspace") {
        return 3;
    }
    return 4;
}
function compareDuplicateCandidateOrder(params) {
    const leftPluginId = params.manifestByRoot.get(params.left.rootDir)?.id;
    const rightPluginId = params.manifestByRoot.get(params.right.rootDir)?.id;
    if (!leftPluginId || leftPluginId !== rightPluginId) {
        return 0;
    }
    return (resolveCandidateDuplicateRank({
        candidate: params.left,
        manifestByRoot: params.manifestByRoot,
        provenance: params.provenance,
        env: params.env,
    }) -
        resolveCandidateDuplicateRank({
            candidate: params.right,
            manifestByRoot: params.manifestByRoot,
            provenance: params.provenance,
            env: params.env,
        }));
}
function warnWhenAllowlistIsOpen(params) {
    if (!params.emitWarning) {
        return;
    }
    if (!params.pluginsEnabled) {
        return;
    }
    if (params.allow.length > 0) {
        return;
    }
    const autoDiscoverable = params.discoverablePlugins.filter((entry) => entry.origin === "workspace" || entry.origin === "global");
    if (autoDiscoverable.length === 0) {
        return;
    }
    if (openAllowlistWarningCache.has(params.warningCacheKey)) {
        return;
    }
    const preview = autoDiscoverable
        .slice(0, 6)
        .map((entry) => `${entry.id} (${entry.source})`)
        .join(", ");
    const extra = autoDiscoverable.length > 6 ? ` (+${autoDiscoverable.length - 6} more)` : "";
    openAllowlistWarningCache.add(params.warningCacheKey);
    params.logger.warn(`[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`);
}
function warnAboutUntrackedLoadedPlugins(params) {
    const allowSet = new Set(params.allowlist);
    for (const plugin of params.registry.plugins) {
        if (plugin.status !== "loaded" || plugin.origin === "bundled") {
            continue;
        }
        if (allowSet.has(plugin.id)) {
            continue;
        }
        if (isTrackedByProvenance({
            pluginId: plugin.id,
            source: plugin.source,
            index: params.provenance,
            env: params.env,
        })) {
            continue;
        }
        const message = "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
        params.registry.diagnostics.push({
            level: "warn",
            pluginId: plugin.id,
            source: plugin.source,
            message,
        });
        if (params.emitWarning) {
            params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
        }
    }
}
function activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir) {
    const preserveGatewayHookRunner = runtimeSubagentMode === "default" &&
        getActivePluginRuntimeSubagentMode() === "gateway-bindable" &&
        getGlobalHookRunner() !== null;
    setActivePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir);
    if (!preserveGatewayHookRunner) {
        initializeGlobalHookRunner(registry);
    }
}
export function loadOpenClawPlugins(options = {}) {
    const { env, cfg, normalized, activationSource, autoEnabledReasons, onlyPluginIds, includeSetupOnlyChannelPlugins, forceSetupOnlyChannelPlugins, requireSetupEntryForSetupOnlyChannelPlugins, preferSetupRuntimeForChannelPlugins, shouldActivate, shouldLoadModules, shouldInstallBundledRuntimeDeps, cacheKey, runtimeSubagentMode, } = resolvePluginLoadCacheContext(options);
    const logger = options.logger ?? defaultLogger();
    const validateOnly = options.mode === "validate";
    const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
    const cacheEnabled = options.cache !== false;
    if (cacheEnabled) {
        const cached = getCachedPluginRegistry(cacheKey);
        if (cached) {
            if (shouldActivate) {
                restoreRegisteredAgentHarnesses(cached.agentHarnesses);
                restorePluginCommands(cached.commands ?? []);
                restoreRegisteredCompactionProviders(cached.compactionProviders);
                restoreDetachedTaskLifecycleRuntimeRegistration(cached.detachedTaskRuntimeRegistration);
                restorePluginInteractiveHandlers(cached.interactiveHandlers ?? []);
                restoreRegisteredMemoryEmbeddingProviders(cached.memoryEmbeddingProviders);
                restoreMemoryPluginState({
                    capability: cached.memoryCapability,
                    corpusSupplements: cached.memoryCorpusSupplements,
                    promptBuilder: cached.memoryPromptBuilder,
                    promptSupplements: cached.memoryPromptSupplements,
                    flushPlanResolver: cached.memoryFlushPlanResolver,
                    runtime: cached.memoryRuntime,
                });
                activatePluginRegistry(cached.registry, cacheKey, runtimeSubagentMode, options.workspaceDir);
            }
            return cached.registry;
        }
    }
    if (inFlightPluginRegistryLoads.has(cacheKey)) {
        throw new PluginLoadReentryError(cacheKey);
    }
    inFlightPluginRegistryLoads.add(cacheKey);
    try {
        // Clear previously registered plugin state before reloading.
        // Skip for non-activating (snapshot) loads to avoid wiping commands from other plugins.
        if (shouldActivate) {
            clearAgentHarnesses();
            clearPluginCommands();
            clearPluginInteractiveHandlers();
            clearDetachedTaskLifecycleRuntimeRegistration();
            clearMemoryPluginState();
        }
        // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests).
        const getJiti = createPluginJitiLoader(options);
        let createPluginRuntimeFactory = null;
        const resolveCreatePluginRuntime = () => {
            if (createPluginRuntimeFactory) {
                return createPluginRuntimeFactory;
            }
            const runtimeModulePath = resolvePluginRuntimeModulePath({
                pluginSdkResolution: options.pluginSdkResolution,
            });
            if (!runtimeModulePath) {
                throw new Error("Unable to resolve plugin runtime module");
            }
            const safeRuntimePath = toSafeImportPath(runtimeModulePath);
            const runtimeModule = withProfile({ source: runtimeModulePath }, "runtime-module", () => getJiti(runtimeModulePath)(safeRuntimePath));
            if (typeof runtimeModule.createPluginRuntime !== "function") {
                throw new Error("Plugin runtime module missing createPluginRuntime export");
            }
            createPluginRuntimeFactory = runtimeModule.createPluginRuntime;
            return createPluginRuntimeFactory;
        };
        // Lazily initialize the runtime so startup paths that discover/skip plugins do
        // not eagerly load every channel/runtime dependency tree.
        let resolvedRuntime = null;
        const resolveRuntime = () => {
            resolvedRuntime ??= resolveCreatePluginRuntime()(options.runtimeOptions);
            return resolvedRuntime;
        };
        const lazyRuntimeReflectionKeySet = new Set(LAZY_RUNTIME_REFLECTION_KEYS);
        const resolveLazyRuntimeDescriptor = (prop) => {
            if (!lazyRuntimeReflectionKeySet.has(prop)) {
                return Reflect.getOwnPropertyDescriptor(resolveRuntime(), prop);
            }
            return {
                configurable: true,
                enumerable: true,
                get() {
                    return Reflect.get(resolveRuntime(), prop);
                },
                set(value) {
                    Reflect.set(resolveRuntime(), prop, value);
                },
            };
        };
        const runtime = new Proxy({}, {
            get(_target, prop, receiver) {
                return Reflect.get(resolveRuntime(), prop, receiver);
            },
            set(_target, prop, value, receiver) {
                return Reflect.set(resolveRuntime(), prop, value, receiver);
            },
            has(_target, prop) {
                return lazyRuntimeReflectionKeySet.has(prop) || Reflect.has(resolveRuntime(), prop);
            },
            ownKeys() {
                return [...LAZY_RUNTIME_REFLECTION_KEYS];
            },
            getOwnPropertyDescriptor(_target, prop) {
                return resolveLazyRuntimeDescriptor(prop);
            },
            defineProperty(_target, prop, attributes) {
                return Reflect.defineProperty(resolveRuntime(), prop, attributes);
            },
            deleteProperty(_target, prop) {
                return Reflect.deleteProperty(resolveRuntime(), prop);
            },
            getPrototypeOf() {
                return Reflect.getPrototypeOf(resolveRuntime());
            },
        });
        const { registry, createApi, rollbackPluginGlobalSideEffects, registerReload, registerNodeHostCommand, registerSecurityAuditCollector, } = createPluginRegistry({
            logger,
            runtime,
            coreGatewayHandlers: options.coreGatewayHandlers,
            activateGlobalSideEffects: shouldActivate,
        });
        const discovery = discoverOpenClawPlugins({
            workspaceDir: options.workspaceDir,
            extraPaths: normalized.loadPaths,
            cache: options.cache,
            env,
        });
        const manifestRegistry = loadPluginManifestRegistry({
            config: cfg,
            workspaceDir: options.workspaceDir,
            cache: options.cache,
            env,
            candidates: discovery.candidates,
            diagnostics: discovery.diagnostics,
        });
        pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
        warnWhenAllowlistIsOpen({
            emitWarning: shouldActivate,
            logger,
            pluginsEnabled: normalized.enabled,
            allow: normalized.allow,
            warningCacheKey: cacheKey,
            // Keep warning input scoped as well so partial snapshot loads only mention the
            // plugins that were intentionally requested for this registry.
            discoverablePlugins: manifestRegistry.plugins
                .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
                .map((plugin) => ({
                id: plugin.id,
                source: plugin.source,
                origin: plugin.origin,
            })),
        });
        const provenance = buildProvenanceIndex({
            config: cfg,
            normalizedLoadPaths: normalized.loadPaths,
            env,
        });
        const manifestByRoot = new Map(manifestRegistry.plugins.map((record) => [record.rootDir, record]));
        const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
            return compareDuplicateCandidateOrder({
                left,
                right,
                manifestByRoot,
                provenance,
                env,
            });
        });
        const seenIds = new Map();
        const bundledRuntimeDepsRetainSpecsByInstallRoot = new Map();
        const memorySlot = normalized.slots.memory;
        let selectedMemoryPluginId = null;
        let memorySlotMatched = false;
        const dreamingEngineId = resolveDreamingSidecarEngineId({ cfg, memorySlot });
        for (const candidate of orderedCandidates) {
            const manifestRecord = manifestByRoot.get(candidate.rootDir);
            if (!manifestRecord) {
                continue;
            }
            const pluginId = manifestRecord.id;
            const matchesRequestedScope = matchesScopedPluginRequest({
                onlyPluginIdSet,
                pluginId,
            });
            // Filter again at import time as a final guard. The earlier manifest filter keeps
            // warnings scoped; this one prevents loading/registering anything outside the scope.
            if (!matchesRequestedScope) {
                continue;
            }
            const activationState = resolveEffectivePluginActivationState({
                id: pluginId,
                origin: candidate.origin,
                config: normalized,
                rootConfig: cfg,
                enabledByDefault: manifestRecord.enabledByDefault,
                activationSource,
                autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId]),
            });
            const existingOrigin = seenIds.get(pluginId);
            if (existingOrigin) {
                const record = createPluginRecord({
                    id: pluginId,
                    name: manifestRecord.name ?? pluginId,
                    description: manifestRecord.description,
                    version: manifestRecord.version,
                    format: manifestRecord.format,
                    bundleFormat: manifestRecord.bundleFormat,
                    bundleCapabilities: manifestRecord.bundleCapabilities,
                    source: candidate.source,
                    rootDir: candidate.rootDir,
                    origin: candidate.origin,
                    workspaceDir: candidate.workspaceDir,
                    enabled: false,
                    activationState,
                    configSchema: Boolean(manifestRecord.configSchema),
                    contracts: manifestRecord.contracts,
                });
                record.status = "disabled";
                record.error = `overridden by ${existingOrigin} plugin`;
                markPluginActivationDisabled(record, record.error);
                registry.plugins.push(record);
                continue;
            }
            const enableState = resolveEffectiveEnableState({
                id: pluginId,
                origin: candidate.origin,
                config: normalized,
                rootConfig: cfg,
                enabledByDefault: manifestRecord.enabledByDefault,
                activationSource,
            });
            const entry = normalized.entries[pluginId];
            const record = createPluginRecord({
                id: pluginId,
                name: manifestRecord.name ?? pluginId,
                description: manifestRecord.description,
                version: manifestRecord.version,
                format: manifestRecord.format,
                bundleFormat: manifestRecord.bundleFormat,
                bundleCapabilities: manifestRecord.bundleCapabilities,
                source: candidate.source,
                rootDir: candidate.rootDir,
                origin: candidate.origin,
                workspaceDir: candidate.workspaceDir,
                enabled: enableState.enabled,
                activationState,
                configSchema: Boolean(manifestRecord.configSchema),
                contracts: manifestRecord.contracts,
            });
            record.kind = manifestRecord.kind;
            record.configUiHints = manifestRecord.configUiHints;
            record.configJsonSchema = manifestRecord.configSchema;
            const pushPluginLoadError = (message) => {
                record.status = "error";
                record.error = message;
                record.failedAt = new Date();
                record.failurePhase = "validation";
                registry.plugins.push(record);
                seenIds.set(pluginId, candidate.origin);
                registry.diagnostics.push({
                    level: "error",
                    pluginId: record.id,
                    source: record.source,
                    message: record.error,
                });
            };
            const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
            let runtimePluginRoot = pluginRoot;
            let runtimeCandidateSource = candidate.origin === "bundled" ? safeRealpathOrResolve(candidate.source) : candidate.source;
            let runtimeSetupSource = candidate.origin === "bundled" && manifestRecord.setupSource
                ? safeRealpathOrResolve(manifestRecord.setupSource)
                : manifestRecord.setupSource;
            const scopedSetupOnlyChannelPluginRequested = includeSetupOnlyChannelPlugins &&
                !validateOnly &&
                Boolean(onlyPluginIdSet) &&
                manifestRecord.channels.length > 0 &&
                (!enableState.enabled || forceSetupOnlyChannelPlugins);
            const canLoadScopedSetupOnlyChannelPlugin = scopedSetupOnlyChannelPluginRequested &&
                (!requireSetupEntryForSetupOnlyChannelPlugins || Boolean(manifestRecord.setupSource));
            const registrationPlan = resolvePluginRegistrationPlan({
                canLoadScopedSetupOnlyChannelPlugin,
                scopedSetupOnlyChannelPluginRequested,
                requireSetupEntryForSetupOnlyChannelPlugins,
                enableStateEnabled: enableState.enabled,
                shouldLoadModules,
                validateOnly,
                shouldActivate,
                manifestRecord,
                cfg,
                env,
                preferSetupRuntimeForChannelPlugins,
            });
            if (!registrationPlan) {
                record.status = "disabled";
                record.error = enableState.reason;
                markPluginActivationDisabled(record, enableState.reason);
                registry.plugins.push(record);
                seenIds.set(pluginId, candidate.origin);
                continue;
            }
            const registrationMode = registrationPlan.mode;
            if (!enableState.enabled) {
                record.status = "disabled";
                record.error = enableState.reason;
                markPluginActivationDisabled(record, enableState.reason);
            }
            if (shouldLoadModules &&
                shouldInstallBundledRuntimeDeps &&
                candidate.origin === "bundled" &&
                enableState.enabled) {
                let runtimeDepsInstallStartedAt = null;
                let runtimeDepsInstallSpecs = [];
                try {
                    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
                    const retainSpecs = bundledRuntimeDepsRetainSpecsByInstallRoot.get(installRoot) ?? [];
                    const depsInstallResult = ensureBundledPluginRuntimeDeps({
                        pluginId: record.id,
                        pluginRoot,
                        env,
                        config: cfg,
                        retainSpecs,
                        installDeps: (installParams) => {
                            const installSpecs = installParams.installSpecs ?? installParams.missingSpecs;
                            runtimeDepsInstallStartedAt = Date.now();
                            runtimeDepsInstallSpecs = installParams.missingSpecs;
                            if (shouldActivate) {
                                logger.info(`[plugins] ${record.id} staging bundled runtime deps (${installParams.missingSpecs.length} missing, ${installSpecs.length} install specs): ${installParams.missingSpecs.join(", ")}`);
                            }
                            const installer = options.bundledRuntimeDepsInstaller ??
                                ((params) => installBundledRuntimeDeps({
                                    installRoot: params.installRoot,
                                    installExecutionRoot: params.installExecutionRoot,
                                    missingSpecs: params.installSpecs ?? params.missingSpecs,
                                    env,
                                }));
                            installer(installParams);
                        },
                    });
                    if (depsInstallResult.installedSpecs.length > 0) {
                        bundledRuntimeDepsRetainSpecsByInstallRoot.set(installRoot, [...new Set([...retainSpecs, ...depsInstallResult.retainSpecs])].toSorted((left, right) => left.localeCompare(right)));
                        if (shouldActivate) {
                            const elapsed = runtimeDepsInstallStartedAt === null
                                ? ""
                                : ` in ${Date.now() - runtimeDepsInstallStartedAt}ms`;
                            logger.info(`[plugins] ${record.id} installed bundled runtime deps${elapsed}: ${depsInstallResult.installedSpecs.join(", ")}`);
                        }
                    }
                    if (path.resolve(installRoot) !== path.resolve(pluginRoot)) {
                        const packageRoot = resolveBundledRuntimeDependencyPackageRoot(pluginRoot);
                        if (packageRoot) {
                            registerBundledRuntimeDependencyNodePath(packageRoot);
                            registerBundledRuntimeDependencyJitiAliases(packageRoot);
                        }
                        registerBundledRuntimeDependencyNodePath(installRoot);
                        registerBundledRuntimeDependencyJitiAliases(installRoot);
                        runtimePluginRoot = mirrorBundledPluginRuntimeRoot({
                            pluginId: record.id,
                            pluginRoot,
                            installRoot,
                        });
                        runtimeCandidateSource =
                            remapBundledPluginRuntimePath({
                                source: runtimeCandidateSource,
                                pluginRoot,
                                mirroredRoot: runtimePluginRoot,
                            }) ?? runtimeCandidateSource;
                        runtimeSetupSource = remapBundledPluginRuntimePath({
                            source: runtimeSetupSource,
                            pluginRoot,
                            mirroredRoot: runtimePluginRoot,
                        });
                    }
                    else {
                        ensureOpenClawPluginSdkAlias(path.dirname(path.dirname(pluginRoot)));
                    }
                }
                catch (error) {
                    if (shouldActivate && runtimeDepsInstallStartedAt !== null) {
                        logger.error(`[plugins] ${record.id} failed to stage bundled runtime deps after ${Date.now() - runtimeDepsInstallStartedAt}ms: ${runtimeDepsInstallSpecs.join(", ")}`);
                    }
                    pushPluginLoadError(`failed to install bundled runtime deps: ${String(error)}`);
                    continue;
                }
            }
            if (record.format === "bundle") {
                const unsupportedCapabilities = (record.bundleCapabilities ?? []).filter((capability) => capability !== "skills" &&
                    capability !== "mcpServers" &&
                    capability !== "settings" &&
                    !((capability === "commands" ||
                        capability === "agents" ||
                        capability === "outputStyles" ||
                        capability === "lspServers") &&
                        (record.bundleFormat === "claude" || record.bundleFormat === "cursor")) &&
                    !(capability === "hooks" &&
                        (record.bundleFormat === "codex" || record.bundleFormat === "claude")));
                for (const capability of unsupportedCapabilities) {
                    registry.diagnostics.push({
                        level: "warn",
                        pluginId: record.id,
                        source: record.source,
                        message: `bundle capability detected but not wired into OpenClaw yet: ${capability}`,
                    });
                }
                if (enableState.enabled &&
                    record.rootDir &&
                    record.bundleFormat &&
                    (record.bundleCapabilities ?? []).includes("mcpServers")) {
                    const runtimeSupport = inspectBundleMcpRuntimeSupport({
                        pluginId: record.id,
                        rootDir: record.rootDir,
                        bundleFormat: record.bundleFormat,
                    });
                    for (const message of runtimeSupport.diagnostics) {
                        registry.diagnostics.push({
                            level: "warn",
                            pluginId: record.id,
                            source: record.source,
                            message,
                        });
                    }
                    if (runtimeSupport.unsupportedServerNames.length > 0) {
                        registry.diagnostics.push({
                            level: "warn",
                            pluginId: record.id,
                            source: record.source,
                            message: "bundle MCP servers use unsupported transports or incomplete configs " +
                                `(stdio only today): ${runtimeSupport.unsupportedServerNames.join(", ")}`,
                        });
                    }
                }
                registry.plugins.push(record);
                seenIds.set(pluginId, candidate.origin);
                continue;
            }
            // Fast-path bundled memory plugins that are guaranteed disabled by slot policy.
            // This avoids opening/importing heavy memory plugin modules that will never register.
            // Exception: the dreaming engine (memory-core by default) must load alongside the
            // selected memory slot plugin so dreaming can run even when lancedb holds the slot.
            if (registrationPlan.runRuntimeCapabilityPolicy &&
                candidate.origin === "bundled" &&
                hasKind(manifestRecord.kind, "memory")) {
                if (pluginId !== dreamingEngineId) {
                    const earlyMemoryDecision = resolveMemorySlotDecision({
                        id: record.id,
                        kind: manifestRecord.kind,
                        slot: memorySlot,
                        selectedId: selectedMemoryPluginId,
                    });
                    if (!earlyMemoryDecision.enabled) {
                        record.enabled = false;
                        record.status = "disabled";
                        record.error = earlyMemoryDecision.reason;
                        markPluginActivationDisabled(record, earlyMemoryDecision.reason);
                        registry.plugins.push(record);
                        seenIds.set(pluginId, candidate.origin);
                        continue;
                    }
                }
            }
            if (!manifestRecord.configSchema) {
                pushPluginLoadError("missing config schema");
                continue;
            }
            if (!shouldLoadModules && registrationPlan.runRuntimeCapabilityPolicy) {
                const memoryDecision = resolveMemorySlotDecision({
                    id: record.id,
                    kind: record.kind,
                    slot: memorySlot,
                    selectedId: selectedMemoryPluginId,
                });
                if (!memoryDecision.enabled && pluginId !== dreamingEngineId) {
                    record.enabled = false;
                    record.status = "disabled";
                    record.error = memoryDecision.reason;
                    markPluginActivationDisabled(record, memoryDecision.reason);
                    registry.plugins.push(record);
                    seenIds.set(pluginId, candidate.origin);
                    continue;
                }
                if (memoryDecision.selected && hasKind(record.kind, "memory")) {
                    selectedMemoryPluginId = record.id;
                    memorySlotMatched = true;
                    record.memorySlotSelected = true;
                }
            }
            const validatedConfig = validatePluginConfig({
                schema: manifestRecord.configSchema,
                cacheKey: manifestRecord.schemaCacheKey,
                value: entry?.config,
            });
            if (!validatedConfig.ok) {
                logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
                pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
                continue;
            }
            if (!shouldLoadModules) {
                registry.plugins.push(record);
                seenIds.set(pluginId, candidate.origin);
                continue;
            }
            const loadSource = registrationPlan.loadSetupEntry && runtimeSetupSource
                ? runtimeSetupSource
                : runtimeCandidateSource;
            const moduleLoadSource = resolveCanonicalDistRuntimeSource(loadSource);
            const moduleRoot = resolveCanonicalDistRuntimeSource(runtimePluginRoot);
            const opened = openBoundaryFileSync({
                absolutePath: moduleLoadSource,
                rootPath: moduleRoot,
                boundaryLabel: "plugin root",
                rejectHardlinks: candidate.origin !== "bundled",
                skipLexicalRootCheck: true,
            });
            if (!opened.ok) {
                pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
                continue;
            }
            const safeSource = opened.path;
            fs.closeSync(opened.fd);
            const safeImportSource = toSafeImportPath(safeSource);
            let mod = null;
            try {
                // Track the plugin as imported once module evaluation begins. Top-level
                // code may have already executed even if evaluation later throws.
                recordImportedPluginId(record.id);
                mod = withProfile({ pluginId: record.id, source: safeSource }, registrationMode, () => getJiti(safeSource)(safeImportSource));
            }
            catch (err) {
                recordPluginError({
                    logger,
                    registry,
                    record,
                    seenIds,
                    pluginId,
                    origin: candidate.origin,
                    phase: "load",
                    error: err,
                    logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
                    diagnosticMessagePrefix: "failed to load plugin: ",
                });
                continue;
            }
            if (registrationPlan.loadSetupEntry && manifestRecord.setupSource) {
                const setupRegistration = resolveSetupChannelRegistration(mod, {
                    installRuntimeDeps: shouldInstallBundledRuntimeDeps &&
                        (enableState.enabled || forceSetupOnlyChannelPlugins),
                });
                if (setupRegistration.loadError) {
                    recordPluginError({
                        logger,
                        registry,
                        record,
                        seenIds,
                        pluginId,
                        origin: candidate.origin,
                        phase: "load",
                        error: setupRegistration.loadError,
                        logPrefix: `[plugins] ${record.id} failed to load setup entry from ${record.source}: `,
                        diagnosticMessagePrefix: "failed to load setup entry: ",
                    });
                    continue;
                }
                if (setupRegistration.plugin) {
                    if (!channelPluginIdBelongsToManifest({
                        channelId: setupRegistration.plugin.id,
                        pluginId: record.id,
                        manifestChannels: manifestRecord.channels,
                    })) {
                        pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", setup export uses "${setupRegistration.plugin.id}")`);
                        continue;
                    }
                    const api = createApi(record, {
                        config: cfg,
                        pluginConfig: {},
                        hookPolicy: entry?.hooks,
                        registrationMode,
                    });
                    let mergedSetupRegistration = setupRegistration;
                    let runtimeSetterApplied = false;
                    if (registrationPlan.loadSetupRuntimeEntry &&
                        setupRegistration.usesBundledSetupContract &&
                        runtimeCandidateSource !== safeSource) {
                        const runtimeOpened = openBoundaryFileSync({
                            absolutePath: runtimeCandidateSource,
                            rootPath: runtimePluginRoot,
                            boundaryLabel: "plugin root",
                            rejectHardlinks: candidate.origin !== "bundled",
                            skipLexicalRootCheck: true,
                        });
                        if (!runtimeOpened.ok) {
                            pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
                            continue;
                        }
                        const safeRuntimeSource = runtimeOpened.path;
                        fs.closeSync(runtimeOpened.fd);
                        const safeRuntimeImportSource = toSafeImportPath(safeRuntimeSource);
                        let runtimeMod = null;
                        try {
                            runtimeMod = withProfile({ pluginId: record.id, source: safeRuntimeSource }, "load-setup-runtime-entry", () => getJiti(safeRuntimeSource)(safeRuntimeImportSource));
                        }
                        catch (err) {
                            recordPluginError({
                                logger,
                                registry,
                                record,
                                seenIds,
                                pluginId,
                                origin: candidate.origin,
                                phase: "load",
                                error: err,
                                logPrefix: `[plugins] ${record.id} failed to load setup-runtime entry from ${record.source}: `,
                                diagnosticMessagePrefix: "failed to load setup-runtime entry: ",
                            });
                            continue;
                        }
                        const runtimeRegistration = resolveBundledRuntimeChannelRegistration(runtimeMod);
                        if (runtimeRegistration.id && runtimeRegistration.id !== record.id) {
                            pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", runtime entry uses "${runtimeRegistration.id}")`);
                            continue;
                        }
                        if (runtimeRegistration.setChannelRuntime) {
                            try {
                                runtimeRegistration.setChannelRuntime(api.runtime);
                                runtimeSetterApplied = true;
                            }
                            catch (err) {
                                recordPluginError({
                                    logger,
                                    registry,
                                    record,
                                    seenIds,
                                    pluginId,
                                    origin: candidate.origin,
                                    phase: "load",
                                    error: err,
                                    logPrefix: `[plugins] ${record.id} failed to apply setup-runtime channel runtime from ${record.source}: `,
                                    diagnosticMessagePrefix: "failed to apply setup-runtime channel runtime: ",
                                });
                                continue;
                            }
                        }
                        const runtimePluginRegistration = loadBundledRuntimeChannelPlugin({
                            registration: runtimeRegistration,
                        });
                        if (runtimePluginRegistration.loadError) {
                            recordPluginError({
                                logger,
                                registry,
                                record,
                                seenIds,
                                pluginId,
                                origin: candidate.origin,
                                phase: "load",
                                error: runtimePluginRegistration.loadError,
                                logPrefix: `[plugins] ${record.id} failed to load setup-runtime channel entry from ${record.source}: `,
                                diagnosticMessagePrefix: "failed to load setup-runtime channel entry: ",
                            });
                            continue;
                        }
                        if (runtimePluginRegistration.plugin) {
                            if (runtimePluginRegistration.plugin.id &&
                                runtimePluginRegistration.plugin.id !== record.id) {
                                pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", runtime export uses "${runtimePluginRegistration.plugin.id}")`);
                                continue;
                            }
                            mergedSetupRegistration = {
                                ...setupRegistration,
                                plugin: mergeSetupRuntimeChannelPlugin(runtimePluginRegistration.plugin, setupRegistration.plugin),
                                setChannelRuntime: runtimeRegistration.setChannelRuntime ?? setupRegistration.setChannelRuntime,
                            };
                        }
                    }
                    const mergedSetupPlugin = mergedSetupRegistration.plugin;
                    if (!mergedSetupPlugin) {
                        continue;
                    }
                    if (!channelPluginIdBelongsToManifest({
                        channelId: mergedSetupPlugin.id,
                        pluginId: record.id,
                        manifestChannels: manifestRecord.channels,
                    })) {
                        pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", setup export uses "${mergedSetupPlugin.id}")`);
                        continue;
                    }
                    if (!runtimeSetterApplied) {
                        try {
                            mergedSetupRegistration.setChannelRuntime?.(api.runtime);
                        }
                        catch (err) {
                            recordPluginError({
                                logger,
                                registry,
                                record,
                                seenIds,
                                pluginId,
                                origin: candidate.origin,
                                phase: "load",
                                error: err,
                                logPrefix: `[plugins] ${record.id} failed to apply setup channel runtime from ${record.source}: `,
                                diagnosticMessagePrefix: "failed to apply setup channel runtime: ",
                            });
                            continue;
                        }
                    }
                    api.registerChannel(mergedSetupPlugin);
                    registry.plugins.push(record);
                    seenIds.set(pluginId, candidate.origin);
                    continue;
                }
            }
            const resolved = resolvePluginModuleExport(mod);
            const definition = resolved.definition;
            const register = resolved.register;
            if (definition?.id && definition.id !== record.id) {
                pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`);
                continue;
            }
            record.name = definition?.name ?? record.name;
            record.description = definition?.description ?? record.description;
            record.version = definition?.version ?? record.version;
            const manifestKind = record.kind;
            const exportKind = definition?.kind;
            if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) {
                registry.diagnostics.push({
                    level: "warn",
                    pluginId: record.id,
                    source: record.source,
                    message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`,
                });
            }
            record.kind = definition?.kind ?? record.kind;
            if (hasKind(record.kind, "memory") && memorySlot === record.id) {
                memorySlotMatched = true;
            }
            if (registrationPlan.runRuntimeCapabilityPolicy) {
                if (pluginId !== dreamingEngineId) {
                    const memoryDecision = resolveMemorySlotDecision({
                        id: record.id,
                        kind: record.kind,
                        slot: memorySlot,
                        selectedId: selectedMemoryPluginId,
                    });
                    if (!memoryDecision.enabled) {
                        record.enabled = false;
                        record.status = "disabled";
                        record.error = memoryDecision.reason;
                        markPluginActivationDisabled(record, memoryDecision.reason);
                        registry.plugins.push(record);
                        seenIds.set(pluginId, candidate.origin);
                        continue;
                    }
                    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
                        selectedMemoryPluginId = record.id;
                        record.memorySlotSelected = true;
                    }
                }
            }
            if (registrationPlan.runFullActivationOnlyRegistrations) {
                if (definition?.reload) {
                    registerReload(record, definition.reload);
                }
                for (const nodeHostCommand of definition?.nodeHostCommands ?? []) {
                    registerNodeHostCommand(record, nodeHostCommand);
                }
                for (const collector of definition?.securityAuditCollectors ?? []) {
                    registerSecurityAuditCollector(record, collector);
                }
            }
            if (validateOnly) {
                registry.plugins.push(record);
                seenIds.set(pluginId, candidate.origin);
                continue;
            }
            if (typeof register !== "function") {
                logger.error(`[plugins] ${record.id} missing register/activate export`);
                pushPluginLoadError(formatMissingPluginRegisterError(mod, env));
                continue;
            }
            const api = createApi(record, {
                config: cfg,
                pluginConfig: validatedConfig.value,
                hookPolicy: entry?.hooks,
                registrationMode,
            });
            const registrySnapshot = snapshotPluginRegistry(registry);
            const previousAgentHarnesses = listRegisteredAgentHarnesses();
            const previousCompactionProviders = listRegisteredCompactionProviders();
            const previousDetachedTaskRuntimeRegistration = getDetachedTaskLifecycleRuntimeRegistration();
            const previousMemoryCapability = getMemoryCapabilityRegistration();
            const previousMemoryEmbeddingProviders = listRegisteredMemoryEmbeddingProviders();
            const previousMemoryFlushPlanResolver = getMemoryFlushPlanResolver();
            const previousMemoryPromptBuilder = getMemoryPromptSectionBuilder();
            const previousMemoryCorpusSupplements = listMemoryCorpusSupplements();
            const previousMemoryPromptSupplements = listMemoryPromptSupplements();
            const previousMemoryRuntime = getMemoryRuntime();
            try {
                withProfile({ pluginId: record.id, source: record.source }, `${registrationMode}:register`, () => runPluginRegisterSync(register, api));
                // Snapshot loads should not replace process-global runtime prompt state.
                if (!shouldActivate) {
                    restoreRegisteredAgentHarnesses(previousAgentHarnesses);
                    restoreRegisteredCompactionProviders(previousCompactionProviders);
                    restoreDetachedTaskLifecycleRuntimeRegistration(previousDetachedTaskRuntimeRegistration);
                    restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
                    restoreMemoryPluginState({
                        capability: previousMemoryCapability,
                        corpusSupplements: previousMemoryCorpusSupplements,
                        promptBuilder: previousMemoryPromptBuilder,
                        promptSupplements: previousMemoryPromptSupplements,
                        flushPlanResolver: previousMemoryFlushPlanResolver,
                        runtime: previousMemoryRuntime,
                    });
                }
                registry.plugins.push(record);
                seenIds.set(pluginId, candidate.origin);
            }
            catch (err) {
                rollbackPluginGlobalSideEffects(record.id);
                restorePluginRegistry(registry, registrySnapshot);
                restoreRegisteredAgentHarnesses(previousAgentHarnesses);
                restoreRegisteredCompactionProviders(previousCompactionProviders);
                restoreDetachedTaskLifecycleRuntimeRegistration(previousDetachedTaskRuntimeRegistration);
                restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
                restoreMemoryPluginState({
                    capability: previousMemoryCapability,
                    corpusSupplements: previousMemoryCorpusSupplements,
                    promptBuilder: previousMemoryPromptBuilder,
                    promptSupplements: previousMemoryPromptSupplements,
                    flushPlanResolver: previousMemoryFlushPlanResolver,
                    runtime: previousMemoryRuntime,
                });
                recordPluginError({
                    logger,
                    registry,
                    record,
                    seenIds,
                    pluginId,
                    origin: candidate.origin,
                    phase: "register",
                    error: err,
                    logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
                    diagnosticMessagePrefix: "plugin failed during register: ",
                });
            }
        }
        // Scoped snapshot loads may intentionally omit the configured memory plugin, so only
        // emit the missing-memory diagnostic for full registry loads.
        if (!onlyPluginIdSet && typeof memorySlot === "string" && !memorySlotMatched) {
            registry.diagnostics.push({
                level: "warn",
                message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
            });
        }
        warnAboutUntrackedLoadedPlugins({
            registry,
            provenance,
            allowlist: normalized.allow,
            emitWarning: shouldActivate,
            logger,
            env,
        });
        maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);
        if (shouldActivate && options.mode !== "validate") {
            const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
            if (failedPlugins.length > 0) {
                logger.warn(`[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(failedPlugins)}). Run 'openclaw plugins list' for details.`);
            }
        }
        if (cacheEnabled) {
            setCachedPluginRegistry(cacheKey, {
                commands: listRegisteredPluginCommands(),
                detachedTaskRuntimeRegistration: getDetachedTaskLifecycleRuntimeRegistration(),
                interactiveHandlers: listPluginInteractiveHandlers(),
                memoryCapability: getMemoryCapabilityRegistration(),
                memoryCorpusSupplements: listMemoryCorpusSupplements(),
                registry,
                agentHarnesses: listRegisteredAgentHarnesses(),
                compactionProviders: listRegisteredCompactionProviders(),
                memoryEmbeddingProviders: listRegisteredMemoryEmbeddingProviders(),
                memoryFlushPlanResolver: getMemoryFlushPlanResolver(),
                memoryPromptBuilder: getMemoryPromptSectionBuilder(),
                memoryPromptSupplements: listMemoryPromptSupplements(),
                memoryRuntime: getMemoryRuntime(),
            });
        }
        if (shouldActivate) {
            activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, options.workspaceDir);
        }
        return registry;
    }
    finally {
        inFlightPluginRegistryLoads.delete(cacheKey);
    }
}
export async function loadOpenClawPluginCliRegistry(options = {}) {
    const { env, cfg, normalized, activationSource, autoEnabledReasons, onlyPluginIds, cacheKey } = resolvePluginLoadCacheContext({
        ...options,
        activate: false,
        cache: false,
    });
    const logger = options.logger ?? defaultLogger();
    const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
    const getJiti = createPluginJitiLoader(options);
    const { registry, registerCli } = createPluginRegistry({
        logger,
        runtime: {},
        coreGatewayHandlers: options.coreGatewayHandlers,
        activateGlobalSideEffects: false,
    });
    const discovery = discoverOpenClawPlugins({
        workspaceDir: options.workspaceDir,
        extraPaths: normalized.loadPaths,
        cache: false,
        env,
    });
    const manifestRegistry = loadPluginManifestRegistry({
        config: cfg,
        workspaceDir: options.workspaceDir,
        cache: false,
        env,
        candidates: discovery.candidates,
        diagnostics: discovery.diagnostics,
    });
    pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
    warnWhenAllowlistIsOpen({
        emitWarning: false,
        logger,
        pluginsEnabled: normalized.enabled,
        allow: normalized.allow,
        warningCacheKey: `${cacheKey}::cli-metadata`,
        discoverablePlugins: manifestRegistry.plugins
            .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
            .map((plugin) => ({
            id: plugin.id,
            source: plugin.source,
            origin: plugin.origin,
        })),
    });
    const provenance = buildProvenanceIndex({
        config: cfg,
        normalizedLoadPaths: normalized.loadPaths,
        env,
    });
    const manifestByRoot = new Map(manifestRegistry.plugins.map((record) => [record.rootDir, record]));
    const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
        return compareDuplicateCandidateOrder({
            left,
            right,
            manifestByRoot,
            provenance,
            env,
        });
    });
    const seenIds = new Map();
    const memorySlot = normalized.slots.memory;
    let selectedMemoryPluginId = null;
    const dreamingEngineId = resolveDreamingSidecarEngineId({ cfg, memorySlot });
    for (const candidate of orderedCandidates) {
        const manifestRecord = manifestByRoot.get(candidate.rootDir);
        if (!manifestRecord) {
            continue;
        }
        const pluginId = manifestRecord.id;
        if (!matchesScopedPluginRequest({
            onlyPluginIdSet,
            pluginId,
        })) {
            continue;
        }
        const activationState = resolveEffectivePluginActivationState({
            id: pluginId,
            origin: candidate.origin,
            config: normalized,
            rootConfig: cfg,
            enabledByDefault: manifestRecord.enabledByDefault,
            activationSource,
            autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId]),
        });
        const existingOrigin = seenIds.get(pluginId);
        if (existingOrigin) {
            const record = createPluginRecord({
                id: pluginId,
                name: manifestRecord.name ?? pluginId,
                description: manifestRecord.description,
                version: manifestRecord.version,
                format: manifestRecord.format,
                bundleFormat: manifestRecord.bundleFormat,
                bundleCapabilities: manifestRecord.bundleCapabilities,
                source: candidate.source,
                rootDir: candidate.rootDir,
                origin: candidate.origin,
                workspaceDir: candidate.workspaceDir,
                enabled: false,
                activationState,
                configSchema: Boolean(manifestRecord.configSchema),
                contracts: manifestRecord.contracts,
            });
            record.status = "disabled";
            record.error = `overridden by ${existingOrigin} plugin`;
            markPluginActivationDisabled(record, record.error);
            registry.plugins.push(record);
            continue;
        }
        const enableState = resolveEffectiveEnableState({
            id: pluginId,
            origin: candidate.origin,
            config: normalized,
            rootConfig: cfg,
            enabledByDefault: manifestRecord.enabledByDefault,
            activationSource,
        });
        const entry = normalized.entries[pluginId];
        const record = createPluginRecord({
            id: pluginId,
            name: manifestRecord.name ?? pluginId,
            description: manifestRecord.description,
            version: manifestRecord.version,
            format: manifestRecord.format,
            bundleFormat: manifestRecord.bundleFormat,
            bundleCapabilities: manifestRecord.bundleCapabilities,
            source: candidate.source,
            rootDir: candidate.rootDir,
            origin: candidate.origin,
            workspaceDir: candidate.workspaceDir,
            enabled: enableState.enabled,
            activationState,
            configSchema: Boolean(manifestRecord.configSchema),
            contracts: manifestRecord.contracts,
        });
        record.kind = manifestRecord.kind;
        record.configUiHints = manifestRecord.configUiHints;
        record.configJsonSchema = manifestRecord.configSchema;
        const pushPluginLoadError = (message) => {
            record.status = "error";
            record.error = message;
            record.failedAt = new Date();
            record.failurePhase = "validation";
            registry.plugins.push(record);
            seenIds.set(pluginId, candidate.origin);
            registry.diagnostics.push({
                level: "error",
                pluginId: record.id,
                source: record.source,
                message: record.error,
            });
        };
        if (!enableState.enabled) {
            record.status = "disabled";
            record.error = enableState.reason;
            markPluginActivationDisabled(record, enableState.reason);
            registry.plugins.push(record);
            seenIds.set(pluginId, candidate.origin);
            continue;
        }
        if (record.format === "bundle") {
            registry.plugins.push(record);
            seenIds.set(pluginId, candidate.origin);
            continue;
        }
        if (!manifestRecord.configSchema) {
            pushPluginLoadError("missing config schema");
            continue;
        }
        const validatedConfig = validatePluginConfig({
            schema: manifestRecord.configSchema,
            cacheKey: manifestRecord.schemaCacheKey,
            value: entry?.config,
        });
        if (!validatedConfig.ok) {
            logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
            pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
            continue;
        }
        const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
        const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);
        const sourceForCliMetadata = candidate.origin === "bundled"
            ? cliMetadataSource
                ? safeRealpathOrResolve(cliMetadataSource)
                : null
            : (cliMetadataSource ?? candidate.source);
        if (!sourceForCliMetadata) {
            record.status = "loaded";
            registry.plugins.push(record);
            seenIds.set(pluginId, candidate.origin);
            continue;
        }
        const opened = openBoundaryFileSync({
            absolutePath: sourceForCliMetadata,
            rootPath: pluginRoot,
            boundaryLabel: "plugin root",
            rejectHardlinks: candidate.origin !== "bundled",
            skipLexicalRootCheck: true,
        });
        if (!opened.ok) {
            pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
            continue;
        }
        const safeSource = opened.path;
        fs.closeSync(opened.fd);
        const safeImportSource = toSafeImportPath(safeSource);
        let mod = null;
        try {
            mod = withProfile({ pluginId: record.id, source: safeSource }, "cli-metadata", () => getJiti(safeSource)(safeImportSource));
        }
        catch (err) {
            recordPluginError({
                logger,
                registry,
                record,
                seenIds,
                pluginId,
                origin: candidate.origin,
                phase: "load",
                error: err,
                logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
                diagnosticMessagePrefix: "failed to load plugin: ",
            });
            continue;
        }
        const resolved = resolvePluginModuleExport(mod);
        const definition = resolved.definition;
        const register = resolved.register;
        if (definition?.id && definition.id !== record.id) {
            pushPluginLoadError(`plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`);
            continue;
        }
        record.name = definition?.name ?? record.name;
        record.description = definition?.description ?? record.description;
        record.version = definition?.version ?? record.version;
        const manifestKind = record.kind;
        const exportKind = definition?.kind;
        if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) {
            registry.diagnostics.push({
                level: "warn",
                pluginId: record.id,
                source: record.source,
                message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`,
            });
        }
        record.kind = definition?.kind ?? record.kind;
        if (pluginId !== dreamingEngineId) {
            const memoryDecision = resolveMemorySlotDecision({
                id: record.id,
                kind: record.kind,
                slot: memorySlot,
                selectedId: selectedMemoryPluginId,
            });
            if (!memoryDecision.enabled) {
                record.enabled = false;
                record.status = "disabled";
                record.error = memoryDecision.reason;
                markPluginActivationDisabled(record, memoryDecision.reason);
                registry.plugins.push(record);
                seenIds.set(pluginId, candidate.origin);
                continue;
            }
            if (memoryDecision.selected && hasKind(record.kind, "memory")) {
                selectedMemoryPluginId = record.id;
                record.memorySlotSelected = true;
            }
        }
        if (typeof register !== "function") {
            logger.error(`[plugins] ${record.id} missing register/activate export`);
            pushPluginLoadError(formatMissingPluginRegisterError(mod, env));
            continue;
        }
        const api = buildPluginApi({
            id: record.id,
            name: record.name,
            version: record.version,
            description: record.description,
            source: record.source,
            rootDir: record.rootDir,
            registrationMode: "cli-metadata",
            config: cfg,
            pluginConfig: validatedConfig.value,
            runtime: {},
            logger,
            resolvePath: (input) => resolveUserPath(input),
            handlers: {
                registerCli: (registrar, opts) => registerCli(record, registrar, opts),
            },
        });
        const registrySnapshot = snapshotPluginRegistry(registry);
        try {
            withProfile({ pluginId: record.id, source: record.source }, "cli-metadata:register", () => runPluginRegisterSync(register, api));
            registry.plugins.push(record);
            seenIds.set(pluginId, candidate.origin);
        }
        catch (err) {
            restorePluginRegistry(registry, registrySnapshot);
            recordPluginError({
                logger,
                registry,
                record,
                seenIds,
                pluginId,
                origin: candidate.origin,
                phase: "register",
                error: err,
                logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
                diagnosticMessagePrefix: "plugin failed during register: ",
            });
        }
    }
    return registry;
}
function safeRealpathOrResolve(value) {
    try {
        return fs.realpathSync(value);
    }
    catch {
        return path.resolve(value);
    }
}
function resolveCliMetadataEntrySource(rootDir) {
    for (const basename of CLI_METADATA_ENTRY_BASENAMES) {
        const candidate = path.join(rootDir, basename);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}
