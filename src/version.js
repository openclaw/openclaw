import { createRequire } from "node:module";
import { normalizeOptionalString } from "./shared/string-coerce.js";
const CORE_PACKAGE_NAME = "openclaw";
const PACKAGE_JSON_CANDIDATES = [
    "../package.json",
    "../../package.json",
    "../../../package.json",
    "./package.json",
];
const BUILD_INFO_CANDIDATES = [
    "../build-info.json",
    "../../build-info.json",
    "./build-info.json",
];
function readVersionFromJsonCandidates(moduleUrl, candidates, opts = {}) {
    try {
        const require = createRequire(moduleUrl);
        for (const candidate of candidates) {
            try {
                const parsed = require(candidate);
                const version = normalizeOptionalString(parsed.version);
                if (!version) {
                    continue;
                }
                if (opts.requirePackageName && parsed.name !== CORE_PACKAGE_NAME) {
                    continue;
                }
                return version;
            }
            catch {
                // ignore missing or unreadable candidate
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
function firstNonEmpty(...values) {
    for (const value of values) {
        const trimmed = normalizeOptionalString(value);
        if (trimmed) {
            return trimmed;
        }
    }
    return undefined;
}
export function readVersionFromPackageJsonForModuleUrl(moduleUrl) {
    return readVersionFromJsonCandidates(moduleUrl, PACKAGE_JSON_CANDIDATES, {
        requirePackageName: true,
    });
}
export function readVersionFromBuildInfoForModuleUrl(moduleUrl) {
    return readVersionFromJsonCandidates(moduleUrl, BUILD_INFO_CANDIDATES);
}
export function resolveVersionFromModuleUrl(moduleUrl) {
    return (readVersionFromPackageJsonForModuleUrl(moduleUrl) ||
        readVersionFromBuildInfoForModuleUrl(moduleUrl));
}
export function resolveBinaryVersion(params) {
    return (firstNonEmpty(params.injectedVersion) ||
        resolveVersionFromModuleUrl(params.moduleUrl) ||
        firstNonEmpty(params.bundledVersion) ||
        params.fallback ||
        "0.0.0");
}
export const RUNTIME_SERVICE_VERSION_FALLBACK = "unknown";
export function resolveUsableRuntimeVersion(version) {
    const trimmed = normalizeOptionalString(version);
    // "0.0.0" is the resolver's hard fallback when module metadata cannot be read.
    // Prefer explicit service/package markers in that edge case.
    if (!trimmed || trimmed === "0.0.0") {
        return undefined;
    }
    return trimmed;
}
function resolveVersionFromRuntimeSources(params) {
    const preferredCandidates = params.preference === "env-first"
        ? [params.env["OPENCLAW_VERSION"], params.runtimeVersion]
        : [params.runtimeVersion, params.env["OPENCLAW_VERSION"]];
    return (firstNonEmpty(...preferredCandidates, params.env["OPENCLAW_SERVICE_VERSION"], params.env["npm_package_version"]) ?? params.fallback);
}
export function resolveRuntimeServiceVersion(env = process.env, fallback = RUNTIME_SERVICE_VERSION_FALLBACK) {
    return resolveVersionFromRuntimeSources({
        env,
        runtimeVersion: resolveUsableRuntimeVersion(VERSION),
        fallback,
        preference: "env-first",
    });
}
export function resolveCompatibilityHostVersion(env = process.env, fallback = RUNTIME_SERVICE_VERSION_FALLBACK) {
    const explicitCompatibilityVersion = firstNonEmpty(env.OPENCLAW_COMPATIBILITY_HOST_VERSION);
    if (explicitCompatibilityVersion) {
        return explicitCompatibilityVersion;
    }
    return resolveVersionFromRuntimeSources({
        env,
        runtimeVersion: resolveUsableRuntimeVersion(VERSION),
        fallback,
        preference: env === process.env ? "runtime-first" : "env-first",
    });
}
// Single source of truth for the current OpenClaw version.
// - Embedded/bundled builds: injected define or env var.
// - Dev/npm builds: package.json.
export const VERSION = resolveBinaryVersion({
    moduleUrl: import.meta.url,
    injectedVersion: typeof __OPENCLAW_VERSION__ === "string" ? __OPENCLAW_VERSION__ : undefined,
    bundledVersion: process.env.OPENCLAW_BUNDLED_VERSION,
});
