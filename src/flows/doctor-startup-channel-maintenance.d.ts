import type { OpenClawConfig } from "../config/types.openclaw.js";
type DoctorStartupMaintenanceRuntime = {
    error: (message: string) => void;
    log: (message: string) => void;
};
export declare function maybeRunDoctorStartupChannelMaintenance(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    runtime: DoctorStartupMaintenanceRuntime;
    shouldRepair: boolean;
}): Promise<void>;
export {};
