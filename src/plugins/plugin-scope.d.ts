export type PluginIdScope = readonly string[] | undefined;
export declare function normalizePluginIdScope(ids?: readonly unknown[]): string[] | undefined;
export declare function hasExplicitPluginIdScope(ids?: readonly string[]): boolean;
export declare function hasNonEmptyPluginIdScope(ids?: readonly string[]): boolean;
export declare function createPluginIdScopeSet(ids?: readonly string[]): ReadonlySet<string> | null;
export declare function serializePluginIdScope(ids?: readonly string[]): string;
