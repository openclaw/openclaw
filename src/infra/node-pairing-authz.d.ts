export type NodeApprovalScope = "operator.pairing" | "operator.write" | "operator.admin";
export declare const OPERATOR_PAIRING_SCOPE: NodeApprovalScope;
export declare const OPERATOR_WRITE_SCOPE: NodeApprovalScope;
export declare const OPERATOR_ADMIN_SCOPE: NodeApprovalScope;
export declare function resolveNodePairApprovalScopes(commands: unknown): NodeApprovalScope[];
