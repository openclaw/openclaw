import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export type LegacyToolsBySenderKeyHit = {
    toolsBySenderPath: Array<string | number>;
    pathLabel: string;
    key: string;
    targetKey: string;
};
export declare function scanLegacyToolsBySenderKeys(cfg: OpenClawConfig): LegacyToolsBySenderKeyHit[];
export declare function collectLegacyToolsBySenderWarnings(params: {
    hits: LegacyToolsBySenderKeyHit[];
    doctorFixCommand: string;
}): string[];
export declare function maybeRepairLegacyToolsBySenderKeys(cfg: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
};
