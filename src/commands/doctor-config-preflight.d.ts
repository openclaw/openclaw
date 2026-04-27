import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type DoctorConfigPreflightResult = {
    snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
    baseConfig: OpenClawConfig;
};
export declare function runDoctorConfigPreflight(options?: {
    migrateState?: boolean;
    migrateLegacyConfig?: boolean;
    repairPrefixedConfig?: boolean;
    invalidConfigNote?: string | false;
}): Promise<DoctorConfigPreflightResult>;
