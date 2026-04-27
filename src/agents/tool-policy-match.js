import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";
function makeToolPolicyMatcher(policy) {
    const deny = compileGlobPatterns({
        raw: expandToolGroups(policy.deny ?? []),
        normalize: normalizeToolName,
    });
    const allow = compileGlobPatterns({
        raw: expandToolGroups(policy.allow ?? []),
        normalize: normalizeToolName,
    });
    return (name) => {
        const normalized = normalizeToolName(name);
        if (matchesAnyGlobPattern(normalized, deny)) {
            return false;
        }
        if (normalized === "apply_patch" && matchesAnyGlobPattern("write", deny)) {
            return false;
        }
        if (allow.length === 0) {
            return true;
        }
        if (matchesAnyGlobPattern(normalized, allow)) {
            return true;
        }
        if (normalized === "apply_patch" && matchesAnyGlobPattern("write", allow)) {
            return true;
        }
        return false;
    };
}
export function isToolAllowedByPolicyName(name, policy) {
    if (!policy) {
        return true;
    }
    return makeToolPolicyMatcher(policy)(name);
}
export function isToolAllowedByPolicies(name, policies) {
    return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
