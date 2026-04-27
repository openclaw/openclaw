import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolverContext } from "./runtime-shared.js";
import type { RuntimeWebDiagnostic, RuntimeWebDiagnosticCode, RuntimeWebFetchMetadata, RuntimeWebSearchMetadata, RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";
export type { RuntimeWebDiagnostic, RuntimeWebDiagnosticCode, RuntimeWebFetchMetadata, RuntimeWebSearchMetadata, RuntimeWebToolsMetadata, };
export declare function resolveRuntimeWebTools(params: {
    sourceConfig: OpenClawConfig;
    resolvedConfig: OpenClawConfig;
    context: ResolverContext;
}): Promise<RuntimeWebToolsMetadata>;
