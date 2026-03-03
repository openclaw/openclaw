export function resolveRuntimeGroupPolicy(params) {
    const configuredFallbackPolicy = params.configuredFallbackPolicy ?? "open";
    const missingProviderFallbackPolicy = params.missingProviderFallbackPolicy ?? "allowlist";
    const groupPolicy = params.providerConfigPresent
        ? (params.groupPolicy ?? params.defaultGroupPolicy ?? configuredFallbackPolicy)
        : (params.groupPolicy ?? missingProviderFallbackPolicy);
    const providerMissingFallbackApplied = !params.providerConfigPresent && params.groupPolicy === undefined;
    return { groupPolicy, providerMissingFallbackApplied };
}
export function resolveDefaultGroupPolicy(cfg) {
    return cfg.channels?.defaults?.groupPolicy;
}
export const GROUP_POLICY_BLOCKED_LABEL = {
    group: "group messages",
    guild: "guild messages",
    room: "room messages",
    channel: "channel messages",
    space: "space messages",
};
/**
 * Standard provider runtime policy:
 * - configured provider fallback: open
 * - missing provider fallback: allowlist (fail-closed)
 */
export function resolveOpenProviderRuntimeGroupPolicy(params) {
    return resolveRuntimeGroupPolicy({
        providerConfigPresent: params.providerConfigPresent,
        groupPolicy: params.groupPolicy,
        defaultGroupPolicy: params.defaultGroupPolicy,
        configuredFallbackPolicy: "open",
        missingProviderFallbackPolicy: "allowlist",
    });
}
/**
 * Strict provider runtime policy:
 * - configured provider fallback: allowlist
 * - missing provider fallback: allowlist (fail-closed)
 */
export function resolveAllowlistProviderRuntimeGroupPolicy(params) {
    return resolveRuntimeGroupPolicy({
        providerConfigPresent: params.providerConfigPresent,
        groupPolicy: params.groupPolicy,
        defaultGroupPolicy: params.defaultGroupPolicy,
        configuredFallbackPolicy: "allowlist",
        missingProviderFallbackPolicy: "allowlist",
    });
}
const warnedMissingProviderGroupPolicy = new Set();
export function warnMissingProviderGroupPolicyFallbackOnce(params) {
    if (!params.providerMissingFallbackApplied) {
        return false;
    }
    const key = `${params.providerKey}:${params.accountId ?? "*"}`;
    if (warnedMissingProviderGroupPolicy.has(key)) {
        return false;
    }
    warnedMissingProviderGroupPolicy.add(key);
    const blockedLabel = params.blockedLabel?.trim() || "group messages";
    params.log(`${params.providerKey}: channels.${params.providerKey} is missing; defaulting groupPolicy to "allowlist" (${blockedLabel} blocked until explicitly configured).`);
    return true;
}
/**
 * Test helper. Keeps warning-cache state deterministic across test files.
 */
export function resetMissingProviderGroupPolicyFallbackWarningsForTesting() {
    warnedMissingProviderGroupPolicy.clear();
}
