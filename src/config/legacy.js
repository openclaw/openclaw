import { LEGACY_CONFIG_MIGRATIONS } from "./legacy.migrations.js";
import { LEGACY_CONFIG_RULES } from "./legacy.rules.js";
function getPathValue(root, path) {
    let cursor = root;
    for (const key of path) {
        if (!cursor || typeof cursor !== "object") {
            return undefined;
        }
        cursor = cursor[key];
    }
    return cursor;
}
export function findLegacyConfigIssues(raw, sourceRaw) {
    if (!raw || typeof raw !== "object") {
        return [];
    }
    const root = raw;
    const sourceRoot = sourceRaw && typeof sourceRaw === "object" ? sourceRaw : root;
    const issues = [];
    for (const rule of LEGACY_CONFIG_RULES) {
        const cursor = getPathValue(root, rule.path);
        if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
            if (rule.requireSourceLiteral) {
                const sourceCursor = getPathValue(sourceRoot, rule.path);
                if (sourceCursor === undefined) {
                    continue;
                }
                if (rule.match && !rule.match(sourceCursor, sourceRoot)) {
                    continue;
                }
            }
            issues.push({ path: rule.path.join("."), message: rule.message });
        }
    }
    return issues;
}
export function applyLegacyMigrations(raw) {
    if (!raw || typeof raw !== "object") {
        return { next: null, changes: [] };
    }
    const next = structuredClone(raw);
    const changes = [];
    for (const migration of LEGACY_CONFIG_MIGRATIONS) {
        migration.apply(next, changes);
    }
    if (changes.length === 0) {
        return { next: null, changes: [] };
    }
    return { next, changes };
}
