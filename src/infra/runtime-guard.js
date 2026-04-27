import process from "node:process";
import { defaultRuntime } from "../runtime.js";
const MIN_NODE = { major: 22, minor: 14, patch: 0 };
const MINIMUM_ENGINE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/i;
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
export function parseSemver(version) {
    if (!version) {
        return null;
    }
    const match = version.match(SEMVER_RE);
    if (!match) {
        return null;
    }
    const [, major, minor, patch] = match;
    return {
        major: Number.parseInt(major, 10),
        minor: Number.parseInt(minor, 10),
        patch: Number.parseInt(patch, 10),
    };
}
export function isAtLeast(version, minimum) {
    if (!version) {
        return false;
    }
    if (version.major !== minimum.major) {
        return version.major > minimum.major;
    }
    if (version.minor !== minimum.minor) {
        return version.minor > minimum.minor;
    }
    return version.patch >= minimum.patch;
}
export function detectRuntime() {
    const kind = process.versions?.node ? "node" : "unknown";
    const version = process.versions?.node ?? null;
    return {
        kind,
        version,
        execPath: process.execPath ?? null,
        pathEnv: process.env.PATH ?? "(not set)",
    };
}
export function runtimeSatisfies(details) {
    const parsed = parseSemver(details.version);
    if (details.kind === "node") {
        return isAtLeast(parsed, MIN_NODE);
    }
    return false;
}
export function isSupportedNodeVersion(version) {
    return isAtLeast(parseSemver(version), MIN_NODE);
}
export function parseMinimumNodeEngine(engine) {
    if (!engine) {
        return null;
    }
    const match = engine.match(MINIMUM_ENGINE_RE);
    if (!match) {
        return null;
    }
    return parseSemver(match[1] ?? null);
}
export function nodeVersionSatisfiesEngine(version, engine) {
    const minimum = parseMinimumNodeEngine(engine);
    if (!minimum) {
        return null;
    }
    return isAtLeast(parseSemver(version), minimum);
}
export function assertSupportedRuntime(runtime = defaultRuntime, details = detectRuntime()) {
    if (runtimeSatisfies(details)) {
        return;
    }
    const versionLabel = details.version ?? "unknown";
    const runtimeLabel = details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
    const execLabel = details.execPath ?? "unknown";
    runtime.error([
        "openclaw requires Node >=22.14.0.",
        `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
        `PATH searched: ${details.pathEnv}`,
        "Install Node: https://nodejs.org/en/download",
        "Upgrade Node and re-run openclaw.",
    ].join("\n"));
    runtime.exit(1);
}
