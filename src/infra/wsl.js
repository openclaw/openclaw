import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
let wslCached = null;
export function resetWSLStateForTests() {
    wslCached = null;
}
export function isWSLEnv() {
    if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
        return true;
    }
    return false;
}
/**
 * Synchronously check if running in WSL.
 * Checks env vars first, then /proc/version.
 */
export function isWSLSync() {
    if (process.platform !== "linux") {
        return false;
    }
    if (isWSLEnv()) {
        return true;
    }
    try {
        const release = normalizeLowercaseStringOrEmpty(readFileSync("/proc/version", "utf8"));
        return release.includes("microsoft") || release.includes("wsl");
    }
    catch {
        return false;
    }
}
/**
 * Synchronously check if running in WSL2.
 */
export function isWSL2Sync() {
    if (!isWSLSync()) {
        return false;
    }
    try {
        const version = normalizeLowercaseStringOrEmpty(readFileSync("/proc/version", "utf8"));
        return version.includes("wsl2") || version.includes("microsoft-standard");
    }
    catch {
        return false;
    }
}
export async function isWSL() {
    if (wslCached !== null) {
        return wslCached;
    }
    if (process.platform !== "linux") {
        wslCached = false;
        return wslCached;
    }
    if (isWSLEnv()) {
        wslCached = true;
        return wslCached;
    }
    try {
        const release = normalizeLowercaseStringOrEmpty(await fs.readFile("/proc/sys/kernel/osrelease", "utf8"));
        wslCached = release.includes("microsoft") || release.includes("wsl");
    }
    catch {
        wslCached = false;
    }
    return wslCached;
}
