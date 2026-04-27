import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function collectOpenPolicyAllowFromWarnings(params: {
    changes: string[];
    doctorFixCommand: string;
}): string[];
export declare function maybeRepairOpenPolicyAllowFrom(cfg: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
};
