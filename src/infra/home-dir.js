import os from "node:os";
import path from "node:path";
function normalize(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
export function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
    const raw = resolveRawHomeDir(env, homedir);
    return raw ? path.resolve(raw) : undefined;
}
function resolveRawHomeDir(env, homedir) {
    const explicitHome = normalize(env.OPENCLAW_HOME);
    if (explicitHome) {
        if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
            const fallbackHome = normalize(env.HOME) ?? normalize(env.USERPROFILE) ?? normalizeSafe(homedir);
            if (fallbackHome) {
                return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
            }
            return undefined;
        }
        return explicitHome;
    }
    const envHome = normalize(env.HOME);
    if (envHome) {
        return envHome;
    }
    const userProfile = normalize(env.USERPROFILE);
    if (userProfile) {
        return userProfile;
    }
    return normalizeSafe(homedir);
}
function normalizeSafe(homedir) {
    try {
        return normalize(homedir());
    }
    catch {
        return undefined;
    }
}
export function resolveRequiredHomeDir(env = process.env, homedir = os.homedir) {
    return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}
export function expandHomePrefix(input, opts) {
    if (!input.startsWith("~")) {
        return input;
    }
    const home = normalize(opts?.home) ??
        resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
    if (!home) {
        return input;
    }
    return input.replace(/^~(?=$|[\\/])/, home);
}
