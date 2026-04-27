import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEffectiveHomeDir, resolveHomeRelativePath, resolveRequiredHomeDir, } from "./infra/home-dir.js";
import { isPlainObject } from "./infra/plain-object.js";
export { escapeRegExp } from "./shared/regexp.js";
export async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
}
/**
 * Check if a file or directory exists at the given path.
 */
export async function pathExists(targetPath) {
    try {
        await fs.promises.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
export function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
export function clampInt(value, min, max) {
    return clampNumber(Math.floor(value), min, max);
}
/** Alias for clampNumber (shorter, more common name) */
export const clamp = clampNumber;
/**
 * Safely parse JSON, returning null on error instead of throwing.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- JSON parsing helper lets callers ascribe the expected payload type.
export function safeParseJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export { isPlainObject };
/**
 * Type guard for Record<string, unknown> (less strict than isPlainObject).
 * Accepts any non-null object that isn't an array.
 */
export function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function normalizeE164(number) {
    const withoutPrefix = number.replace(/^[a-z][a-z0-9-]*:/i, "").trim();
    const digits = withoutPrefix.replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) {
        return `+${digits.slice(1)}`;
    }
    return `+${digits}`;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isHighSurrogate(codeUnit) {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit) {
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
export function sliceUtf16Safe(input, start, end) {
    const len = input.length;
    let from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    let to = end === undefined ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
    if (to < from) {
        const tmp = from;
        from = to;
        to = tmp;
    }
    if (from > 0 && from < len) {
        const codeUnit = input.charCodeAt(from);
        if (isLowSurrogate(codeUnit) && isHighSurrogate(input.charCodeAt(from - 1))) {
            from += 1;
        }
    }
    if (to > 0 && to < len) {
        const codeUnit = input.charCodeAt(to - 1);
        if (isHighSurrogate(codeUnit) && isLowSurrogate(input.charCodeAt(to))) {
            to -= 1;
        }
    }
    return input.slice(from, to);
}
export function truncateUtf16Safe(input, maxLen) {
    const limit = Math.max(0, Math.floor(maxLen));
    if (input.length <= limit) {
        return input;
    }
    return sliceUtf16Safe(input, 0, limit);
}
export function resolveUserPath(input, env = process.env, homedir = os.homedir) {
    if (!input) {
        return "";
    }
    return resolveHomeRelativePath(input, { env, homedir });
}
export function resolveConfigDir(env = process.env, homedir = os.homedir) {
    const override = env.OPENCLAW_STATE_DIR?.trim();
    if (override) {
        return resolveUserPath(override, env, homedir);
    }
    const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
    if (configPath) {
        return path.dirname(resolveUserPath(configPath, env, homedir));
    }
    const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
    try {
        const hasNew = fs.existsSync(newDir);
        if (hasNew) {
            return newDir;
        }
    }
    catch {
        // best-effort
    }
    return newDir;
}
export function resolveHomeDir() {
    return resolveEffectiveHomeDir(process.env, os.homedir);
}
function resolveHomeDisplayPrefix() {
    const home = resolveHomeDir();
    if (!home) {
        return undefined;
    }
    const explicitHome = process.env.OPENCLAW_HOME?.trim();
    if (explicitHome) {
        return { home, prefix: "$OPENCLAW_HOME" };
    }
    return { home, prefix: "~" };
}
export function shortenHomePath(input) {
    if (!input) {
        return input;
    }
    const display = resolveHomeDisplayPrefix();
    if (!display) {
        return input;
    }
    const { home, prefix } = display;
    if (input === home) {
        return prefix;
    }
    if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
        return `${prefix}${input.slice(home.length)}`;
    }
    return input;
}
export function shortenHomeInString(input) {
    if (!input) {
        return input;
    }
    const display = resolveHomeDisplayPrefix();
    if (!display) {
        return input;
    }
    return input.split(display.home).join(display.prefix);
}
export function displayPath(input) {
    return shortenHomePath(input);
}
export function displayString(input) {
    return shortenHomeInString(input);
}
// Configuration root; can be overridden via OPENCLAW_STATE_DIR.
export const CONFIG_DIR = resolveConfigDir();
