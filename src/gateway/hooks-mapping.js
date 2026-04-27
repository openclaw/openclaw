import fs from "node:fs";
import path from "node:path";
import { resolveConfigPathCandidate } from "../config/paths.js";
import { importFileModule, resolveFunctionModuleExport } from "../hooks/module-loader.js";
import { normalizeOptionalString, readStringValue } from "../shared/string-coerce.js";
const hookPresetMappings = {
    gmail: [
        {
            id: "gmail",
            match: { path: "gmail" },
            action: "agent",
            wakeMode: "now",
            name: "Gmail",
            sessionKey: "hook:gmail:{{messages[0].id}}",
            messageTemplate: "New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}\n{{messages[0].body}}",
        },
    ],
};
const transformCache = new Map();
export function resolveHookMappings(hooks, opts) {
    const presets = hooks?.presets ?? [];
    const gmailAllowUnsafe = hooks?.gmail?.allowUnsafeExternalContent;
    const mappings = [];
    if (hooks?.mappings) {
        mappings.push(...hooks.mappings);
    }
    for (const preset of presets) {
        const presetMappings = hookPresetMappings[preset];
        if (!presetMappings) {
            continue;
        }
        if (preset === "gmail" && typeof gmailAllowUnsafe === "boolean") {
            mappings.push(...presetMappings.map((mapping) => ({
                ...mapping,
                allowUnsafeExternalContent: gmailAllowUnsafe,
            })));
            continue;
        }
        mappings.push(...presetMappings);
    }
    if (mappings.length === 0) {
        return [];
    }
    const configDir = path.resolve(opts?.configDir ?? path.dirname(resolveConfigPathCandidate()));
    const transformsRootDir = path.join(configDir, "hooks", "transforms");
    const transformsDir = resolveOptionalContainedPath(transformsRootDir, hooks?.transformsDir, "Hook transformsDir");
    return mappings.map((mapping, index) => normalizeHookMapping(mapping, index, transformsDir));
}
export async function applyHookMappings(mappings, ctx) {
    if (mappings.length === 0) {
        return null;
    }
    for (const mapping of mappings) {
        if (!mappingMatches(mapping, ctx)) {
            continue;
        }
        const base = buildActionFromMapping(mapping, ctx);
        if (!base.ok) {
            return base;
        }
        let override = null;
        if (mapping.transform) {
            const transform = await loadTransform(mapping.transform);
            override = await transform(ctx);
            if (override === null) {
                return { ok: true, action: null, skipped: true };
            }
        }
        if (!base.action) {
            return { ok: true, action: null, skipped: true };
        }
        const merged = mergeAction(base.action, override, mapping.action);
        if (!merged.ok) {
            return merged;
        }
        return merged;
    }
    return null;
}
function normalizeHookMapping(mapping, index, transformsDir) {
    const id = normalizeOptionalString(mapping.id) || `mapping-${index + 1}`;
    const matchPath = normalizeMatchPath(mapping.match?.path);
    const matchSource = mapping.match?.source?.trim();
    const action = mapping.action ?? "agent";
    const wakeMode = mapping.wakeMode ?? "now";
    const transform = mapping.transform
        ? {
            modulePath: resolveContainedPath(transformsDir, mapping.transform.module, "Hook transform"),
            exportName: normalizeOptionalString(mapping.transform.export),
        }
        : undefined;
    return {
        id,
        matchPath,
        matchSource,
        action,
        wakeMode,
        name: mapping.name,
        agentId: normalizeOptionalString(mapping.agentId),
        sessionKey: mapping.sessionKey,
        messageTemplate: mapping.messageTemplate,
        textTemplate: mapping.textTemplate,
        deliver: mapping.deliver,
        allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
        channel: mapping.channel,
        to: mapping.to,
        model: mapping.model,
        thinking: mapping.thinking,
        timeoutSeconds: mapping.timeoutSeconds,
        transform,
    };
}
function mappingMatches(mapping, ctx) {
    if (mapping.matchPath) {
        if (mapping.matchPath !== normalizeMatchPath(ctx.path)) {
            return false;
        }
    }
    if (mapping.matchSource) {
        const source = readStringValue(ctx.payload.source);
        if (!source || source !== mapping.matchSource) {
            return false;
        }
    }
    return true;
}
function buildActionFromMapping(mapping, ctx) {
    if (mapping.action === "wake") {
        const text = renderTemplate(mapping.textTemplate ?? "", ctx);
        return {
            ok: true,
            action: {
                kind: "wake",
                text,
                mode: mapping.wakeMode ?? "now",
            },
        };
    }
    const message = renderTemplate(mapping.messageTemplate ?? "", ctx);
    return {
        ok: true,
        action: {
            kind: "agent",
            message,
            name: renderOptional(mapping.name, ctx),
            agentId: mapping.agentId,
            wakeMode: mapping.wakeMode ?? "now",
            sessionKey: renderOptional(mapping.sessionKey, ctx),
            sessionKeySource: getSessionKeyTemplateSource(mapping.sessionKey),
            deliver: mapping.deliver,
            allowUnsafeExternalContent: mapping.allowUnsafeExternalContent,
            channel: mapping.channel,
            to: renderOptional(mapping.to, ctx),
            model: renderOptional(mapping.model, ctx),
            thinking: renderOptional(mapping.thinking, ctx),
            timeoutSeconds: mapping.timeoutSeconds,
        },
    };
}
function mergeAction(base, override, defaultAction) {
    if (!override) {
        return validateAction(base);
    }
    const kind = override.kind ?? base.kind ?? defaultAction;
    if (kind === "wake") {
        const baseWake = base.kind === "wake" ? base : undefined;
        const text = typeof override.text === "string" ? override.text : (baseWake?.text ?? "");
        const mode = override.mode === "next-heartbeat" ? "next-heartbeat" : (baseWake?.mode ?? "now");
        return validateAction({ kind: "wake", text, mode });
    }
    const baseAgent = base.kind === "agent" ? base : undefined;
    const message = typeof override.message === "string" ? override.message : (baseAgent?.message ?? "");
    const wakeMode = override.wakeMode === "next-heartbeat" ? "next-heartbeat" : (baseAgent?.wakeMode ?? "now");
    return validateAction({
        kind: "agent",
        message,
        wakeMode,
        name: override.name ?? baseAgent?.name,
        agentId: override.agentId ?? baseAgent?.agentId,
        sessionKey: override.sessionKey ?? baseAgent?.sessionKey,
        sessionKeySource: resolveMergedSessionKeySource(baseAgent, override),
        deliver: typeof override.deliver === "boolean" ? override.deliver : baseAgent?.deliver,
        allowUnsafeExternalContent: typeof override.allowUnsafeExternalContent === "boolean"
            ? override.allowUnsafeExternalContent
            : baseAgent?.allowUnsafeExternalContent,
        channel: override.channel ?? baseAgent?.channel,
        to: override.to ?? baseAgent?.to,
        model: override.model ?? baseAgent?.model,
        thinking: override.thinking ?? baseAgent?.thinking,
        timeoutSeconds: override.timeoutSeconds ?? baseAgent?.timeoutSeconds,
    });
}
function validateAction(action) {
    if (action.kind === "wake") {
        if (!action.text?.trim()) {
            return { ok: false, error: "hook mapping requires text" };
        }
        return { ok: true, action };
    }
    if (!action.message?.trim()) {
        return { ok: false, error: "hook mapping requires message" };
    }
    return { ok: true, action };
}
function getSessionKeyTemplateSource(sessionKeyTemplate) {
    const normalizedTemplate = normalizeOptionalString(sessionKeyTemplate);
    if (!normalizedTemplate) {
        return undefined;
    }
    return hasHookTemplateExpressions(normalizedTemplate) ? "templated" : "static";
}
function resolveMergedSessionKeySource(baseAgent, override) {
    if (typeof override.sessionKey === "string") {
        const normalizedSessionKey = normalizeOptionalString(override.sessionKey);
        if (!normalizedSessionKey) {
            // Empty transform overrides behave like an absent sessionKey and fall
            // through to the default/generated key path later in hook dispatch.
            return undefined;
        }
        return override.sessionKeySource === "static" ? "static" : "templated";
    }
    return baseAgent?.sessionKeySource;
}
export function hasHookTemplateExpressions(template) {
    return /\{\{\s*[^}]+\s*\}\}/.test(template);
}
async function loadTransform(transform) {
    const cacheKey = `${transform.modulePath}::${transform.exportName ?? "default"}`;
    const cached = transformCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    const mod = await importFileModule({ modulePath: transform.modulePath });
    const fn = resolveTransformFn(mod, transform.exportName);
    transformCache.set(cacheKey, fn);
    return fn;
}
function resolveTransformFn(mod, exportName) {
    const candidate = resolveFunctionModuleExport({
        mod,
        exportName,
        fallbackExportNames: ["default", "transform"],
    });
    if (!candidate) {
        throw new Error("hook transform module must export a function");
    }
    return candidate;
}
function resolvePath(baseDir, target) {
    if (!target) {
        return path.resolve(baseDir);
    }
    return path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
}
function escapesBase(baseDir, candidate) {
    const relative = path.relative(baseDir, candidate);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
function safeRealpathSync(candidate) {
    try {
        const nativeRealpath = fs.realpathSync.native;
        return nativeRealpath ? nativeRealpath(candidate) : fs.realpathSync(candidate);
    }
    catch {
        return null;
    }
}
function resolveExistingAncestor(candidate) {
    let current = path.resolve(candidate);
    while (true) {
        if (fs.existsSync(current)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}
function resolveContainedPath(baseDir, target, label) {
    const base = path.resolve(baseDir);
    const trimmed = target?.trim();
    if (!trimmed) {
        throw new Error(`${label} module path is required`);
    }
    const resolved = resolvePath(base, trimmed);
    if (escapesBase(base, resolved)) {
        throw new Error(`${label} module path must be within ${base}: ${target}`);
    }
    // Block symlink escapes for existing path segments while preserving current
    // behavior for not-yet-created files.
    const baseRealpath = safeRealpathSync(base);
    const existingAncestor = resolveExistingAncestor(resolved);
    const existingAncestorRealpath = existingAncestor ? safeRealpathSync(existingAncestor) : null;
    if (baseRealpath &&
        existingAncestorRealpath &&
        escapesBase(baseRealpath, existingAncestorRealpath)) {
        throw new Error(`${label} module path must be within ${base}: ${target}`);
    }
    return resolved;
}
function resolveOptionalContainedPath(baseDir, target, label) {
    const trimmed = target?.trim();
    if (!trimmed) {
        return path.resolve(baseDir);
    }
    return resolveContainedPath(baseDir, trimmed, label);
}
function normalizeMatchPath(raw) {
    if (!raw) {
        return undefined;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    return trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
}
function renderOptional(value, ctx) {
    if (!value) {
        return undefined;
    }
    const rendered = renderTemplate(value, ctx).trim();
    return rendered ? rendered : undefined;
}
function renderTemplate(template, ctx) {
    if (!template) {
        return "";
    }
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr) => {
        const value = resolveTemplateExpr(expr.trim(), ctx);
        if (value === undefined || value === null) {
            return "";
        }
        if (typeof value === "string") {
            return value;
        }
        if (typeof value === "number" || typeof value === "boolean") {
            return String(value);
        }
        return JSON.stringify(value);
    });
}
function resolveTemplateExpr(expr, ctx) {
    if (expr === "path") {
        return ctx.path;
    }
    if (expr === "now") {
        return new Date().toISOString();
    }
    if (expr.startsWith("headers.")) {
        return getByPath(ctx.headers, expr.slice("headers.".length));
    }
    if (expr.startsWith("query.")) {
        return getByPath(Object.fromEntries(ctx.url.searchParams.entries()), expr.slice("query.".length));
    }
    if (expr.startsWith("payload.")) {
        return getByPath(ctx.payload, expr.slice("payload.".length));
    }
    return getByPath(ctx.payload, expr);
}
// Block traversal into prototype-chain properties on attacker-controlled
// webhook payloads.  Mirrors the same blocklist used by config-paths.ts
// for config path traversal.
const BLOCKED_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function getByPath(input, pathExpr) {
    if (!pathExpr) {
        return undefined;
    }
    const parts = [];
    const re = /([^.[\]]+)|(\[(\d+)\])/g;
    let match = re.exec(pathExpr);
    while (match) {
        if (match[1]) {
            parts.push(match[1]);
        }
        else if (match[3]) {
            parts.push(Number(match[3]));
        }
        match = re.exec(pathExpr);
    }
    let current = input;
    for (const part of parts) {
        if (current === null || current === undefined) {
            return undefined;
        }
        if (typeof part === "number") {
            if (!Array.isArray(current)) {
                return undefined;
            }
            current = current[part];
            continue;
        }
        if (BLOCKED_PATH_KEYS.has(part)) {
            return undefined;
        }
        if (typeof current !== "object") {
            return undefined;
        }
        current = current[part];
    }
    return current;
}
