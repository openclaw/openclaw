import { collectChannelLegacyConfigRules } from "../channels/plugins/legacy-config.js";
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
function collectExplicitRuleOwnedChannelIds(extraRules) {
    const channelIds = new Set();
    for (const rule of extraRules) {
        const [first, second] = rule.path;
        if (first !== "channels" || typeof second !== "string" || second === "defaults") {
            continue;
        }
        channelIds.add(second);
    }
    return channelIds.size > 0 ? channelIds : undefined;
}
export function findLegacyConfigIssues(raw, sourceRaw, extraRules = [], touchedPaths) {
    if (!raw || typeof raw !== "object") {
        return [];
    }
    const root = raw;
    const sourceRoot = sourceRaw && typeof sourceRaw === "object" ? sourceRaw : root;
    const issues = [];
    const explicitRuleOwnedChannelIds = collectExplicitRuleOwnedChannelIds(extraRules);
    for (const rule of [
        ...LEGACY_CONFIG_RULES,
        ...collectChannelLegacyConfigRules(raw, touchedPaths, explicitRuleOwnedChannelIds),
        ...extraRules,
    ]) {
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
