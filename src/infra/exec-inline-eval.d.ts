export type InterpreterInlineEvalHit = {
    executable: string;
    normalizedExecutable: string;
    flag: string;
    argv: string[];
};
export declare function detectInterpreterInlineEvalArgv(argv: string[] | undefined | null): InterpreterInlineEvalHit | null;
export declare function describeInterpreterInlineEval(hit: InterpreterInlineEvalHit): string;
export declare function isInterpreterLikeAllowlistPattern(pattern: string | undefined | null): boolean;
