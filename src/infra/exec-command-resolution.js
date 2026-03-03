import fs from "node:fs";
import path from "node:path";
import { resolveDispatchWrapperExecutionPlan } from "./exec-wrapper-resolution.js";
import { resolveExecutablePath as resolveExecutableCandidatePath } from "./executable-path.js";
import { expandHomePrefix } from "./home-dir.js";
export const DEFAULT_SAFE_BINS = ["jq", "cut", "uniq", "head", "tail", "tr", "wc"];
function parseFirstToken(command) {
    const trimmed = command.trim();
    if (!trimmed) {
        return null;
    }
    const first = trimmed[0];
    if (first === '"' || first === "'") {
        const end = trimmed.indexOf(first, 1);
        if (end > 1) {
            return trimmed.slice(1, end);
        }
        return trimmed.slice(1);
    }
    const match = /^[^\s]+/.exec(trimmed);
    return match ? match[0] : null;
}
function tryResolveRealpath(filePath) {
    if (!filePath) {
        return undefined;
    }
    try {
        return fs.realpathSync(filePath);
    }
    catch {
        return undefined;
    }
}
export function resolveCommandResolution(command, cwd, env) {
    const rawExecutable = parseFirstToken(command);
    if (!rawExecutable) {
        return null;
    }
    const resolvedPath = resolveExecutableCandidatePath(rawExecutable, { cwd, env });
    const resolvedRealPath = tryResolveRealpath(resolvedPath);
    const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
    return {
        rawExecutable,
        resolvedPath,
        resolvedRealPath,
        executableName,
        effectiveArgv: [rawExecutable],
        wrapperChain: [],
        policyBlocked: false,
    };
}
export function resolveCommandResolutionFromArgv(argv, cwd, env) {
    const plan = resolveDispatchWrapperExecutionPlan(argv);
    const effectiveArgv = plan.argv;
    const rawExecutable = effectiveArgv[0]?.trim();
    if (!rawExecutable) {
        return null;
    }
    const resolvedPath = resolveExecutableCandidatePath(rawExecutable, { cwd, env });
    const resolvedRealPath = tryResolveRealpath(resolvedPath);
    const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
    return {
        rawExecutable,
        resolvedPath,
        resolvedRealPath,
        executableName,
        effectiveArgv,
        wrapperChain: plan.wrappers,
        policyBlocked: plan.policyBlocked,
        blockedWrapper: plan.blockedWrapper,
    };
}
function normalizeMatchTarget(value) {
    if (process.platform === "win32") {
        const stripped = value.replace(/^\\\\[?.]\\/, "");
        return stripped.replace(/\\/g, "/").toLowerCase();
    }
    return value.replace(/\\\\/g, "/").toLowerCase();
}
function tryRealpath(value) {
    try {
        return fs.realpathSync(value);
    }
    catch {
        return null;
    }
}
function globToRegExp(pattern) {
    let regex = "^";
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === "*") {
            const next = pattern[i + 1];
            if (next === "*") {
                regex += ".*";
                i += 2;
                continue;
            }
            regex += "[^/]*";
            i += 1;
            continue;
        }
        if (ch === "?") {
            regex += ".";
            i += 1;
            continue;
        }
        regex += ch.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
        i += 1;
    }
    regex += "$";
    return new RegExp(regex, "i");
}
function matchesPattern(pattern, target) {
    const trimmed = pattern.trim();
    if (!trimmed) {
        return false;
    }
    const expanded = trimmed.startsWith("~") ? expandHomePrefix(trimmed) : trimmed;
    const hasWildcard = /[*?]/.test(expanded);
    let normalizedPattern = expanded;
    let normalizedTarget = target;
    if (process.platform === "win32" && !hasWildcard) {
        normalizedPattern = tryRealpath(expanded) ?? expanded;
        normalizedTarget = tryRealpath(target) ?? target;
    }
    normalizedPattern = normalizeMatchTarget(normalizedPattern);
    normalizedTarget = normalizeMatchTarget(normalizedTarget);
    const regex = globToRegExp(normalizedPattern);
    return regex.test(normalizedTarget);
}
export function resolveAllowlistCandidatePath(resolution, cwd) {
    if (!resolution) {
        return undefined;
    }
    if (resolution.resolvedPath) {
        return resolution.resolvedPath;
    }
    const raw = resolution.rawExecutable?.trim();
    if (!raw) {
        return undefined;
    }
    const expanded = raw.startsWith("~") ? expandHomePrefix(raw) : raw;
    if (!expanded.includes("/") && !expanded.includes("\\")) {
        return undefined;
    }
    if (path.isAbsolute(expanded)) {
        return expanded;
    }
    const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
    return path.resolve(base, expanded);
}
export function matchAllowlist(entries, resolution) {
    if (!entries.length) {
        return null;
    }
    // A bare "*" wildcard allows any parsed executable command.
    // Check it before the resolvedPath guard so unresolved PATH lookups still
    // match (for example platform-specific executables without known extensions).
    const bareWild = entries.find((e) => e.pattern?.trim() === "*");
    if (bareWild && resolution) {
        return bareWild;
    }
    if (!resolution?.resolvedPath) {
        return null;
    }
    const resolvedPath = resolution.resolvedPath;
    for (const entry of entries) {
        const pattern = entry.pattern?.trim();
        if (!pattern) {
            continue;
        }
        const hasPath = pattern.includes("/") || pattern.includes("\\") || pattern.includes("~");
        if (!hasPath) {
            continue;
        }
        if (matchesPattern(pattern, resolvedPath)) {
            return entry;
        }
    }
    return null;
}
/**
 * Tokenizes a single argv entry into a normalized option/positional model.
 * Consumers can share this model to keep argv parsing behavior consistent.
 */
export function parseExecArgvToken(raw) {
    if (!raw) {
        return { kind: "empty", raw };
    }
    if (raw === "--") {
        return { kind: "terminator", raw };
    }
    if (raw === "-") {
        return { kind: "stdin", raw };
    }
    if (!raw.startsWith("-")) {
        return { kind: "positional", raw };
    }
    if (raw.startsWith("--")) {
        const eqIndex = raw.indexOf("=");
        if (eqIndex > 0) {
            return {
                kind: "option",
                raw,
                style: "long",
                flag: raw.slice(0, eqIndex),
                inlineValue: raw.slice(eqIndex + 1),
            };
        }
        return { kind: "option", raw, style: "long", flag: raw };
    }
    const cluster = raw.slice(1);
    return {
        kind: "option",
        raw,
        style: "short-cluster",
        cluster,
        flags: cluster.split("").map((entry) => `-${entry}`),
    };
}
