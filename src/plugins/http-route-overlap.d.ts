import type { OpenClawPluginHttpRouteMatch } from "./types.js";
type PluginHttpRouteLike = {
    path: string;
    match: OpenClawPluginHttpRouteMatch;
};
export declare function doPluginHttpRoutesOverlap(a: Pick<PluginHttpRouteLike, "path" | "match">, b: Pick<PluginHttpRouteLike, "path" | "match">): boolean;
export declare function findOverlappingPluginHttpRoute<T extends {
    path: string;
    match: OpenClawPluginHttpRouteMatch;
}>(routes: readonly T[], candidate: PluginHttpRouteLike): T | undefined;
export {};
