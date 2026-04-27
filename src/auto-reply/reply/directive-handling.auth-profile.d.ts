import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveProfileOverride(params: {
    rawProfile?: string;
    provider: string;
    cfg: OpenClawConfig;
    agentDir?: string;
}): {
    profileId?: string;
    error?: string;
};
