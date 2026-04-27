import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";
export const BOOTSTRAP_HANDOFF_OPERATOR_SCOPES = [
    "operator.approvals",
    "operator.read",
    "operator.talk.secrets",
    "operator.write",
];
const BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET = new Set(BOOTSTRAP_HANDOFF_OPERATOR_SCOPES);
export const PAIRING_SETUP_BOOTSTRAP_PROFILE = {
    roles: ["node", "operator"],
    scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES],
};
export function resolveBootstrapProfileScopesForRole(role, scopes) {
    const normalizedRole = normalizeDeviceAuthRole(role);
    const normalizedScopes = normalizeDeviceAuthScopes(Array.from(scopes));
    if (normalizedRole === "operator") {
        return normalizedScopes.filter((scope) => BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET.has(scope));
    }
    return [];
}
function normalizeBootstrapRoles(roles) {
    if (!Array.isArray(roles)) {
        return [];
    }
    const out = new Set();
    for (const role of roles) {
        const normalized = normalizeDeviceAuthRole(role);
        if (normalized) {
            out.add(normalized);
        }
    }
    return [...out].toSorted();
}
export function normalizeDeviceBootstrapProfile(input) {
    return {
        roles: normalizeBootstrapRoles(input?.roles),
        scopes: normalizeDeviceAuthScopes(input?.scopes ? [...input.scopes] : []),
    };
}
