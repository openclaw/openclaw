import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function hasConfiguredInternalHooks(config: OpenClawConfig): boolean;
export declare function resolveConfiguredInternalHookNames(config: OpenClawConfig): Set<string> | null;
