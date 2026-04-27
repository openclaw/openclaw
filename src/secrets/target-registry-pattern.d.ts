import type { SecretTargetRegistryEntry } from "./target-registry-types.js";
export type PathPatternToken = {
    kind: "literal";
    value: string;
} | {
    kind: "wildcard";
} | {
    kind: "array";
    field: string;
};
export type CompiledTargetRegistryEntry = SecretTargetRegistryEntry & {
    pathTokens: PathPatternToken[];
    pathDynamicTokenCount: number;
    refPathTokens?: PathPatternToken[];
    refPathDynamicTokenCount: number;
};
export type ExpandedPathMatch = {
    segments: string[];
    captures: string[];
    value: unknown;
};
export declare function parsePathPattern(pathPattern: string): PathPatternToken[];
export declare function compileTargetRegistryEntry(entry: SecretTargetRegistryEntry): CompiledTargetRegistryEntry;
export declare function matchPathTokens(segments: string[], tokens: PathPatternToken[]): {
    captures: string[];
} | null;
export declare function materializePathTokens(tokens: PathPatternToken[], captures: string[]): string[] | null;
export declare function expandPathTokens(root: unknown, tokens: PathPatternToken[]): ExpandedPathMatch[];
