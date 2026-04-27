import path from "node:path";
import { CONFIG_PATH } from "../config/config.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { note } from "../terminal/note.js";
import { isRecord } from "../utils.js";
function normalizeIssuePath(path) {
    return path.filter((part) => typeof part !== "symbol");
}
function isUnrecognizedKeysIssue(issue) {
    return issue.code === "unrecognized_keys";
}
export function formatConfigPath(parts) {
    if (parts.length === 0) {
        return "<root>";
    }
    let out = "";
    for (const part of parts) {
        if (typeof part === "number") {
            out += `[${part}]`;
            continue;
        }
        out = out ? `${out}.${part}` : part;
    }
    return out || "<root>";
}
export function resolveConfigPathTarget(root, path) {
    let current = root;
    for (const part of path) {
        if (typeof part === "number") {
            if (!Array.isArray(current)) {
                return null;
            }
            if (part < 0 || part >= current.length) {
                return null;
            }
            current = current[part];
            continue;
        }
        if (!current || typeof current !== "object" || Array.isArray(current)) {
            return null;
        }
        const record = current;
        if (!(part in record)) {
            return null;
        }
        current = record[part];
    }
    return current;
}
export function stripUnknownConfigKeys(config) {
    const parsed = OpenClawSchema.safeParse(config);
    if (parsed.success) {
        return { config, removed: [] };
    }
    const next = structuredClone(config);
    const removed = [];
    for (const issue of parsed.error.issues) {
        if (!isUnrecognizedKeysIssue(issue)) {
            continue;
        }
        const issuePath = normalizeIssuePath(issue.path);
        const target = resolveConfigPathTarget(next, issuePath);
        if (!target || typeof target !== "object" || Array.isArray(target)) {
            continue;
        }
        const record = target;
        for (const key of issue.keys) {
            if (typeof key !== "string" || !(key in record)) {
                continue;
            }
            delete record[key];
            removed.push(formatConfigPath([...issuePath, key]));
        }
    }
    return { config: next, removed };
}
export function noteOpencodeProviderOverrides(cfg) {
    const providers = cfg.models?.providers;
    if (!providers) {
        return;
    }
    const overrides = [];
    if (providers.opencode) {
        overrides.push("opencode");
    }
    if (providers["opencode-zen"]) {
        overrides.push("opencode-zen");
    }
    if (providers["opencode-go"]) {
        overrides.push("opencode-go");
    }
    if (overrides.length === 0) {
        return;
    }
    const lines = overrides.flatMap((id) => {
        const providerLabel = id === "opencode-go" ? "OpenCode Go" : "OpenCode Zen";
        const providerEntry = providers[id];
        const api = isRecord(providerEntry) && typeof providerEntry.api === "string"
            ? providerEntry.api
            : undefined;
        return [
            `- models.providers.${id} is set; this overrides the built-in ${providerLabel} catalog.`,
            api ? `- models.providers.${id}.api=${api}` : null,
        ].filter((line) => Boolean(line));
    });
    lines.push("- Remove these entries to restore per-model API routing + costs (then re-run setup if needed).");
    note(lines.join("\n"), "OpenCode");
}
export function noteIncludeConfinementWarning(snapshot) {
    const issues = snapshot.issues ?? [];
    const includeIssue = issues.find((issue) => issue.message.includes("Include path escapes config directory") ||
        issue.message.includes("Include path resolves outside config directory"));
    if (!includeIssue) {
        return;
    }
    const configRoot = path.dirname(snapshot.path ?? CONFIG_PATH);
    note([
        `- $include paths must stay under: ${configRoot}`,
        '- Move shared include files under that directory and update to relative paths like "./shared/common.json".',
        `- Error: ${includeIssue.message}`,
    ].join("\n"), "Doctor warnings");
}
