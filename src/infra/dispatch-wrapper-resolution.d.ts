export declare const MAX_DISPATCH_WRAPPER_DEPTH = 4;
export declare function isEnvAssignment(token: string): boolean;
export declare function unwrapEnvInvocation(argv: string[]): string[] | null;
export declare function extractEnvAssignmentKeysFromDispatchWrappers(argv: string[], maxDepth?: number): string[];
export declare const DISPATCH_WRAPPER_EXECUTABLES: Set<string>;
export type DispatchWrapperUnwrapResult = {
    kind: "not-wrapper";
} | {
    kind: "blocked";
    wrapper: string;
} | {
    kind: "unwrapped";
    wrapper: string;
    argv: string[];
};
export type DispatchWrapperTrustPlan = {
    argv: string[];
    wrappers: string[];
    policyBlocked: boolean;
    blockedWrapper?: string;
};
export declare function isDispatchWrapperExecutable(token: string): boolean;
export declare function unwrapKnownDispatchWrapperInvocation(argv: string[], platform?: NodeJS.Platform): DispatchWrapperUnwrapResult;
export declare function unwrapDispatchWrappersForResolution(argv: string[], maxDepth?: number, platform?: NodeJS.Platform): string[];
export declare function resolveDispatchWrapperTrustPlan(argv: string[], maxDepth?: number, platform?: NodeJS.Platform): DispatchWrapperTrustPlan;
export declare function hasDispatchEnvManipulation(argv: string[]): boolean;
