import { NODE_SYSTEM_RUN_COMMANDS } from "./node-commands.js";
export const OPERATOR_PAIRING_SCOPE = "operator.pairing";
export const OPERATOR_WRITE_SCOPE = "operator.write";
export const OPERATOR_ADMIN_SCOPE = "operator.admin";
export function resolveNodePairApprovalScopes(commands) {
    const normalized = Array.isArray(commands)
        ? commands.filter((command) => typeof command === "string")
        : [];
    if (normalized.some((command) => NODE_SYSTEM_RUN_COMMANDS.some((allowed) => allowed === command))) {
        return [OPERATOR_PAIRING_SCOPE, OPERATOR_ADMIN_SCOPE];
    }
    if (normalized.length > 0) {
        return [OPERATOR_PAIRING_SCOPE, OPERATOR_WRITE_SCOPE];
    }
    return [OPERATOR_PAIRING_SCOPE];
}
