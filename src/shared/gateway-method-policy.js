export const RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES = [
    "exec.approvals.",
    "config.",
    "wizard.",
    "update.",
];
export const RESERVED_ADMIN_GATEWAY_METHOD_SCOPE = "operator.admin";
export function isReservedAdminGatewayMethod(method) {
    return RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}
export function resolveReservedGatewayMethodScope(method) {
    if (!isReservedAdminGatewayMethod(method)) {
        return undefined;
    }
    return RESERVED_ADMIN_GATEWAY_METHOD_SCOPE;
}
export function normalizePluginGatewayMethodScope(method, scope) {
    const reservedScope = resolveReservedGatewayMethodScope(method);
    if (!reservedScope || !scope || scope === reservedScope) {
        return {
            scope,
            coercedToReservedAdmin: false,
        };
    }
    return {
        scope: reservedScope,
        coercedToReservedAdmin: true,
    };
}
