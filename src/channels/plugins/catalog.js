import fs from "node:fs";
import path from "node:path";
import officialExternalChannelCatalog from "../../../scripts/lib/official-external-channel-catalog.json" with { type: "json" };
import { MANIFEST_KEY } from "../../compat/legacy-names.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import { describePluginInstallSource, } from "../../plugins/install-source-info.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../../utils.js";
import { buildManifestChannelMeta } from "./channel-meta.js";
const ORIGIN_PRIORITY = {
    config: 0,
    workspace: 1,
    global: 2,
    bundled: 3,
};
const EXTERNAL_CATALOG_PRIORITY = ORIGIN_PRIORITY.bundled + 1;
const FALLBACK_CATALOG_PRIORITY = EXTERNAL_CATALOG_PRIORITY + 1;
const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
function parseCatalogEntries(raw) {
    if (Array.isArray(raw)) {
        return raw.filter((entry) => isRecord(entry));
    }
    if (!isRecord(raw)) {
        return [];
    }
    const list = raw.entries ?? raw.packages ?? raw.plugins;
    if (!Array.isArray(list)) {
        return [];
    }
    return list.filter((entry) => isRecord(entry));
}
function splitEnvPaths(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return [];
    }
    return trimmed
        .split(/[;,]/g)
        .flatMap((chunk) => chunk.split(path.delimiter))
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function resolveDefaultCatalogPaths(env) {
    const configDir = resolveConfigDir(env);
    return [
        path.join(configDir, "mpm", "plugins.json"),
        path.join(configDir, "mpm", "catalog.json"),
        path.join(configDir, "plugins", "catalog.json"),
    ];
}
function resolveExternalCatalogPaths(options) {
    if (options.catalogPaths && options.catalogPaths.length > 0) {
        return options.catalogPaths.map((entry) => entry.trim()).filter(Boolean);
    }
    const env = options.env ?? process.env;
    for (const key of ENV_CATALOG_PATHS) {
        const raw = env[key];
        if (raw && raw.trim()) {
            return splitEnvPaths(raw);
        }
    }
    return resolveDefaultCatalogPaths(env);
}
function loadExternalCatalogEntries(options) {
    const paths = resolveExternalCatalogPaths(options).map((rawPath) => resolveUserPath(rawPath, options.env ?? process.env));
    return loadCatalogEntriesFromPaths(paths);
}
function loadCatalogEntriesFromPaths(paths) {
    const entries = [];
    for (const resolvedPath of paths) {
        if (!fs.existsSync(resolvedPath)) {
            continue;
        }
        try {
            const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
            entries.push(...parseCatalogEntries(payload));
        }
        catch {
            // Ignore invalid catalog files.
        }
    }
    return entries;
}
function resolveOfficialCatalogPaths(options) {
    if (options.officialCatalogPaths && options.officialCatalogPaths.length > 0) {
        return options.officialCatalogPaths.map((entry) => entry.trim()).filter(Boolean);
    }
    const packageRoots = [
        resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
        resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
    ].filter((entry, index, all) => Boolean(entry) && all.indexOf(entry) === index);
    const candidates = packageRoots.map((packageRoot) => path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
    if (process.execPath) {
        const execDir = path.dirname(process.execPath);
        candidates.push(path.join(execDir, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH));
        candidates.push(path.join(execDir, "channel-catalog.json"));
    }
    return candidates.filter((entry, index, all) => entry && all.indexOf(entry) === index);
}
function loadOfficialCatalogEntries(options) {
    const builtInEntries = parseCatalogEntries(officialExternalChannelCatalog);
    const fileEntries = loadCatalogEntriesFromPaths(resolveOfficialCatalogPaths(options));
    return [...builtInEntries, ...fileEntries]
        .map((entry) => buildExternalCatalogEntry(entry))
        .filter((entry) => Boolean(entry));
}
function toChannelMeta(params) {
    const label = params.channel.label?.trim();
    if (!label) {
        return null;
    }
    const selectionLabel = params.channel.selectionLabel?.trim() || label;
    const detailLabel = params.channel.detailLabel?.trim();
    const docsPath = params.channel.docsPath?.trim() || `/channels/${params.id}`;
    const blurb = params.channel.blurb?.trim() || "";
    const systemImage = params.channel.systemImage?.trim();
    return buildManifestChannelMeta({
        id: params.id,
        channel: params.channel,
        label,
        selectionLabel,
        docsPath,
        docsLabel: normalizeOptionalString(params.channel.docsLabel),
        blurb,
        detailLabel,
        ...(systemImage ? { systemImage } : {}),
        arrayFieldMode: "defined",
        selectionDocsPrefixMode: "truthy",
    });
}
function resolveInstallInfo(params) {
    const npmSpec = params.install?.npmSpec?.trim() ?? params.packageName?.trim();
    if (!npmSpec) {
        return null;
    }
    let localPath = normalizeOptionalString(params.install?.localPath);
    if (!localPath && params.workspaceDir && params.packageDir) {
        localPath = path.relative(params.workspaceDir, params.packageDir) || undefined;
    }
    const defaultChoice = params.install?.defaultChoice ?? (localPath ? "local" : "npm");
    return {
        npmSpec,
        ...(localPath ? { localPath } : {}),
        ...(defaultChoice ? { defaultChoice } : {}),
        ...(params.install?.minHostVersion ? { minHostVersion: params.install.minHostVersion } : {}),
        ...(params.install?.expectedIntegrity
            ? { expectedIntegrity: params.install.expectedIntegrity }
            : {}),
        ...(params.install?.allowInvalidConfigRecovery === true
            ? { allowInvalidConfigRecovery: true }
            : {}),
    };
}
function buildCatalogEntryFromManifest(params) {
    if (!params.channel) {
        return null;
    }
    const id = params.channel.id?.trim();
    if (!id) {
        return null;
    }
    const meta = toChannelMeta({ channel: params.channel, id });
    if (!meta) {
        return null;
    }
    const install = resolveInstallInfo({
        install: params.install,
        packageName: params.packageName,
        packageDir: params.packageDir,
        workspaceDir: params.workspaceDir,
    });
    if (!install) {
        return null;
    }
    const pluginId = normalizeOptionalString(params.pluginId);
    return {
        id,
        ...(pluginId ? { pluginId } : {}),
        ...(params.origin ? { origin: params.origin } : {}),
        meta,
        install,
        installSource: describePluginInstallSource(install, {
            expectedPackageName: params.packageName,
        }),
    };
}
function buildExternalCatalogEntry(entry) {
    const manifest = entry[MANIFEST_KEY];
    return buildCatalogEntryFromManifest({
        packageName: entry.name,
        channel: manifest?.channel,
        install: manifest?.install,
    });
}
export function buildChannelUiCatalog(plugins) {
    const entries = plugins.map((plugin) => {
        const detailLabel = plugin.meta.detailLabel ?? plugin.meta.selectionLabel ?? plugin.meta.label;
        return {
            id: plugin.id,
            label: plugin.meta.label,
            detailLabel,
            ...(plugin.meta.systemImage ? { systemImage: plugin.meta.systemImage } : {}),
        };
    });
    const order = entries.map((entry) => entry.id);
    const labels = {};
    const detailLabels = {};
    const systemImages = {};
    const byId = {};
    for (const entry of entries) {
        labels[entry.id] = entry.label;
        detailLabels[entry.id] = entry.detailLabel;
        if (entry.systemImage) {
            systemImages[entry.id] = entry.systemImage;
        }
        byId[entry.id] = entry;
    }
    return { entries, order, labels, detailLabels, systemImages, byId };
}
export function listChannelPluginCatalogEntries(options = {}) {
    const manifestEntries = listChannelCatalogEntries({
        workspaceDir: options.workspaceDir,
        env: options.env,
    });
    const resolved = new Map();
    for (const candidate of manifestEntries) {
        if (options.excludeWorkspace && candidate.origin === "workspace") {
            continue;
        }
        const entry = buildCatalogEntryFromManifest({
            pluginId: candidate.pluginId,
            packageName: candidate.packageName,
            packageDir: candidate.rootDir,
            origin: candidate.origin,
            workspaceDir: candidate.workspaceDir ?? options.workspaceDir,
            channel: candidate.channel,
            install: candidate.install,
        });
        if (!entry) {
            continue;
        }
        const priority = ORIGIN_PRIORITY[candidate.origin] ?? 99;
        const existing = resolved.get(entry.id);
        if (!existing || priority < existing.priority) {
            resolved.set(entry.id, { entry, priority });
        }
    }
    for (const entry of loadOfficialCatalogEntries(options)) {
        const priority = FALLBACK_CATALOG_PRIORITY;
        const existing = resolved.get(entry.id);
        if (!existing || priority < existing.priority) {
            resolved.set(entry.id, { entry, priority });
        }
    }
    const externalEntries = loadExternalCatalogEntries(options)
        .map((entry) => buildExternalCatalogEntry(entry))
        .filter((entry) => Boolean(entry));
    for (const entry of externalEntries) {
        // External catalogs are the supported override seam for shipped fallback
        // metadata, but discovered plugins should still win when they are present.
        const priority = EXTERNAL_CATALOG_PRIORITY;
        const existing = resolved.get(entry.id);
        if (!existing || priority < existing.priority) {
            resolved.set(entry.id, { entry, priority });
        }
    }
    return Array.from(resolved.values())
        .map(({ entry }) => entry)
        .toSorted((a, b) => {
        const orderA = a.meta.order ?? 999;
        const orderB = b.meta.order ?? 999;
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        return a.meta.label.localeCompare(b.meta.label);
    });
}
export function getChannelPluginCatalogEntry(id, options = {}) {
    const trimmed = id.trim();
    if (!trimmed) {
        return undefined;
    }
    return listChannelPluginCatalogEntries(options).find((entry) => entry.id === trimmed);
}
