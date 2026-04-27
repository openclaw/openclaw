import { ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE, READ_SCOPE, TALK_SECRETS_SCOPE, WRITE_SCOPE, type OperatorScope } from "./operator-scopes.js";
export { ADMIN_SCOPE, APPROVALS_SCOPE, PAIRING_SCOPE, READ_SCOPE, TALK_SECRETS_SCOPE, WRITE_SCOPE, type OperatorScope, };
export declare const CLI_DEFAULT_OPERATOR_SCOPES: OperatorScope[];
export declare function isApprovalMethod(method: string): boolean;
export declare function isPairingMethod(method: string): boolean;
export declare function isReadMethod(method: string): boolean;
export declare function isWriteMethod(method: string): boolean;
export declare function isNodeRoleMethod(method: string): boolean;
export declare function isAdminOnlyMethod(method: string): boolean;
export declare function resolveRequiredOperatorScopeForMethod(method: string): OperatorScope | undefined;
export declare function resolveLeastPrivilegeOperatorScopesForMethod(method: string): OperatorScope[];
export declare function authorizeOperatorScopesForMethod(method: string, scopes: readonly string[]): {
    allowed: true;
} | {
    allowed: false;
    missingScope: OperatorScope;
};
export declare function isGatewayMethodClassified(method: string): boolean;
