import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function maybeRepairAllowlistPolicyAllowFrom(cfg: OpenClawConfig): Promise<{
    config: OpenClawConfig;
    changes: string[];
}>;
