import type { OpenClawConfig } from "../../../config/types.js";
export { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
export declare function migrateLegacyConfig(raw: unknown): {
    config: OpenClawConfig | null;
    changes: string[];
};
