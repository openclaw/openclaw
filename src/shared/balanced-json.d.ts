export type JsonOpeningDelimiter = "{" | "[";
export type BalancedJsonFragment = {
    json: string;
    startIndex: number;
    endIndex: number;
};
export declare function extractBalancedJsonPrefix(raw: string, opts?: {
    openers?: readonly JsonOpeningDelimiter[];
}): BalancedJsonFragment | null;
export declare function extractBalancedJsonFragments(raw: string, opts?: {
    openers?: readonly JsonOpeningDelimiter[];
}): BalancedJsonFragment[];
