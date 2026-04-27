import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "../shared/string-coerce.js";
function normalize(value) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        return undefined;
    }
    if (trimmed === "undefined" || trimmed === "null") {
        return undefined;
    }
    return trimmed;
}
export function resolveEffectiveHomeDir(env = process.env, homedir = os.homedir) {
    const raw = resolveRawHomeDir(env, homedir);
    return raw ? path.resolve(raw) : undefined;
}
export function resolveOsHomeDir(env = process.env, homedir = os.homedir) {
    const raw = resolveRawOsHomeDir(env, homedir);
    return raw ? path.resolve(raw) : undefined;
}
function resolveRawHomeDir(env, homedir) {
    const explicitHome = normalize(env.OPENCLAW_HOME);
    if (explicitHome) {
        if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
            const fallbackHome = resolveRawOsHomeDir(env, homedir);
            if (fallbackHome) {
                return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
            }
            return undefined;
        }
        return explicitHome;
    }
    return resolveRawOsHomeDir(env, homedir);
}
function resolveRawOsHomeDir(env, homedir) {
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
export function resolveRequiredOsHomeDir(env = process.env, homedir = os.homedir) {
    return resolveOsHomeDir(env, homedir) ?? path.resolve(process.cwd());
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
export function resolveHomeRelativePath(input, opts) {
    const trimmed = input.trim();
    if (!trimmed) {
        return trimmed;
    }
    if (trimmed.startsWith("~")) {
        const expanded = expandHomePrefix(trimmed, {
            home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
            env: opts?.env,
            homedir: opts?.homedir,
        });
        return path.resolve(expanded);
    }
    return path.resolve(trimmed);
}
export function resolveOsHomeRelativePath(input, opts) {
    const trimmed = input.trim();
    if (!trimmed) {
        return trimmed;
    }
    if (trimmed.startsWith("~")) {
        const expanded = expandHomePrefix(trimmed, {
            home: resolveRequiredOsHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
            env: opts?.env,
            homedir: opts?.homedir,
        });
        return path.resolve(expanded);
    }
    return path.resolve(trimmed);
}
