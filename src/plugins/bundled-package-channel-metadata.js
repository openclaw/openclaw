import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledPluginScanDir } from "./bundled-plugin-scan.js";
import { getPackageManifestMetadata, } from "./manifest.js";
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
    CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
let bundledPackageChannelMetadataCache;
function readPackageManifest(pluginDir) {
    const packagePath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(packagePath)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    }
    catch {
        return undefined;
    }
}
export function listBundledPackageChannelMetadata() {
    if (bundledPackageChannelMetadataCache) {
        return bundledPackageChannelMetadataCache;
    }
    const scanDir = resolveBundledPluginScanDir({
        packageRoot: PACKAGE_ROOT,
        runningFromBuiltArtifact: RUNNING_FROM_BUILT_ARTIFACT,
    });
    if (!scanDir || !fs.existsSync(scanDir)) {
        bundledPackageChannelMetadataCache = [];
        return bundledPackageChannelMetadataCache;
    }
    bundledPackageChannelMetadataCache = fs
        .readdirSync(scanDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => readPackageManifest(path.join(scanDir, entry.name)))
        .map((manifest) => getPackageManifestMetadata(manifest)?.channel)
        .filter((channel) => Boolean(channel?.id));
    return bundledPackageChannelMetadataCache;
}
export function findBundledPackageChannelMetadata(channelId) {
    return listBundledPackageChannelMetadata().find((channel) => channel.id === channelId || channel.aliases?.includes(channelId));
}
