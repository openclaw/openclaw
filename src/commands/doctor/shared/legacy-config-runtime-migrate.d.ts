import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function normalizeRuntimeCompatibilityConfigValues(cfg: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
};
