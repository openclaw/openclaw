import { normalizeOptionalString } from "../shared/string-coerce.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifest } from "./manifest.js";
export function findBundledPluginSourceInMap(params) {
    const targetValue = params.lookup.value.trim();
    if (!targetValue) {
        return undefined;
    }
    if (params.lookup.kind === "pluginId") {
        return params.bundled.get(targetValue);
    }
    for (const source of params.bundled.values()) {
        if (source.npmSpec === targetValue) {
            return source;
        }
    }
    return undefined;
}
export function resolveBundledPluginSources(params) {
    const discovery = discoverOpenClawPlugins({
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
    const bundled = new Map();
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
        const npmSpec = normalizeOptionalString(candidate.packageManifest?.install?.npmSpec) ||
            normalizeOptionalString(candidate.packageName) ||
            undefined;
        bundled.set(pluginId, {
            pluginId,
            localPath: candidate.rootDir,
            npmSpec,
        });
    }
    return bundled;
}
export function findBundledPluginSource(params) {
    const bundled = resolveBundledPluginSources({
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
    return findBundledPluginSourceInMap({
        bundled,
        lookup: params.lookup,
    });
}
export function resolveBundledPluginInstallCommandHint(params) {
    const bundledSource = findBundledPluginSource({
        lookup: { kind: "pluginId", value: params.pluginId },
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
    if (!bundledSource?.localPath) {
        return null;
    }
    return `openclaw plugins install ${bundledSource.localPath}`;
}
