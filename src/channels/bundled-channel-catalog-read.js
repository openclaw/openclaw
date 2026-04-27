import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH = path.join("dist", "channel-catalog.json");
function listPackageRoots() {
    return [
        resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
        resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
    ].filter((entry, index, all) => Boolean(entry) && all.indexOf(entry) === index);
}
function listBundledExtensionPackageJsonPaths(env = process.env) {
    // Delegate to the plugin loader's resolver so channel metadata stays in lock
    // step with whichever bundled plugin tree is actually loaded at runtime
    // (source extensions/ in dev/test, dist/extensions in published installs,
    // dist-runtime/extensions when paired with dist, etc.). See
    // src/plugins/bundled-dir.ts for the full candidate-order policy and
    // src/plugins/bundled-dir.test.ts for the precedence coverage. Reusing the
    // resolver also picks up OPENCLAW_BUNDLED_PLUGINS_DIR overrides and the
    // bun --compile sibling layout for free.
    const extensionsRoot = resolveBundledPluginsDir(env);
    if (!extensionsRoot) {
        return [];
    }
    try {
        return fs
            .readdirSync(extensionsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(extensionsRoot, entry.name, "package.json"))
            .filter((entry) => fs.existsSync(entry));
    }
    catch {
        return [];
    }
}
function readBundledExtensionCatalogEntriesSync() {
    const entries = [];
    for (const packageJsonPath of listBundledExtensionPackageJsonPaths()) {
        try {
            const payload = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
            entries.push(payload);
        }
        catch {
            continue;
        }
    }
    return entries;
}
function readOfficialCatalogFileSync() {
    for (const packageRoot of listPackageRoots()) {
        const candidate = path.join(packageRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
        if (!fs.existsSync(candidate)) {
            continue;
        }
        try {
            const payload = JSON.parse(fs.readFileSync(candidate, "utf8"));
            return Array.isArray(payload.entries) ? payload.entries : [];
        }
        catch {
            continue;
        }
    }
    return [];
}
function toBundledChannelEntry(entry) {
    const channel = entry.openclaw?.channel;
    const id = normalizeOptionalLowercaseString(channel?.id);
    if (!id || !channel) {
        return null;
    }
    const aliases = Array.isArray(channel.aliases)
        ? channel.aliases
            .map((alias) => normalizeOptionalLowercaseString(alias))
            .filter((alias) => Boolean(alias))
        : [];
    const order = typeof channel.order === "number" && Number.isFinite(channel.order)
        ? channel.order
        : Number.MAX_SAFE_INTEGER;
    return {
        id,
        channel,
        aliases,
        order,
    };
}
export function listBundledChannelCatalogEntries() {
    const bundledEntries = readBundledExtensionCatalogEntriesSync()
        .map((entry) => toBundledChannelEntry(entry))
        .filter((entry) => Boolean(entry));
    if (bundledEntries.length > 0) {
        return bundledEntries;
    }
    return readOfficialCatalogFileSync()
        .map((entry) => toBundledChannelEntry(entry))
        .filter((entry) => Boolean(entry));
}
