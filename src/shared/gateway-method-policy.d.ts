export declare const RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES: readonly ["exec.approvals.", "config.", "wizard.", "update."];
export declare const RESERVED_ADMIN_GATEWAY_METHOD_SCOPE: "operator.admin";
export declare function isReservedAdminGatewayMethod(method: string): boolean;
export declare function resolveReservedGatewayMethodScope(method: string): typeof RESERVED_ADMIN_GATEWAY_METHOD_SCOPE | undefined;
export declare function normalizePluginGatewayMethodScope<TScope extends string>(method: string, scope: TScope | undefined): {
    scope: TScope | typeof RESERVED_ADMIN_GATEWAY_METHOD_SCOPE | undefined;
    coercedToReservedAdmin: boolean;
};
