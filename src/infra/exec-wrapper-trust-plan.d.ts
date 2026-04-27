export type ExecWrapperTrustPlan = {
    argv: string[];
    policyArgv: string[];
    wrapperChain: string[];
    policyBlocked: boolean;
    blockedWrapper?: string;
    shellWrapperExecutable: boolean;
    shellInlineCommand: string | null;
};
export declare function resolveExecWrapperTrustPlan(argv: string[], maxDepth?: number): ExecWrapperTrustPlan;
