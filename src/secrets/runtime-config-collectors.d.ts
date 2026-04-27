import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { ResolverContext } from "./runtime-shared.js";
export declare function collectConfigAssignments(params: {
    config: OpenClawConfig;
    context: ResolverContext;
    loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): void;
