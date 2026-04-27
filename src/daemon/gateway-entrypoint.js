import path from "node:path";
import { pathExists } from "../utils.js";
const GATEWAY_DIST_ENTRYPOINT_BASENAMES = [
    "index.js",
    "index.mjs",
    "entry.js",
    "entry.mjs",
];
export function isGatewayDistEntrypointPath(inputPath) {
    return /[/\\]dist[/\\].+\.(cjs|js|mjs)$/.test(inputPath);
}
export function buildGatewayInstallEntrypointCandidates(root) {
    if (!root) {
        return [];
    }
    return GATEWAY_DIST_ENTRYPOINT_BASENAMES.map((basename) => path.join(root, "dist", basename));
}
export function buildGatewayDistEntrypointCandidates(...inputs) {
    const distDirs = [];
    const seenDirs = new Set();
    for (const inputPath of inputs) {
        if (!isGatewayDistEntrypointPath(inputPath)) {
            continue;
        }
        const distDir = path.dirname(inputPath);
        if (seenDirs.has(distDir)) {
            continue;
        }
        seenDirs.add(distDir);
        distDirs.push(distDir);
    }
    const candidates = [];
    for (const basename of GATEWAY_DIST_ENTRYPOINT_BASENAMES) {
        for (const distDir of distDirs) {
            candidates.push(path.join(distDir, basename));
        }
    }
    return candidates;
}
export async function findFirstAccessibleGatewayEntrypoint(candidates, exists = pathExists) {
    for (const candidate of candidates) {
        if (await exists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
export async function resolveGatewayInstallEntrypoint(root, exists = pathExists) {
    return findFirstAccessibleGatewayEntrypoint(buildGatewayInstallEntrypointCandidates(root), exists);
}
