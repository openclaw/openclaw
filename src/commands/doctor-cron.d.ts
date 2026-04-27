import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter, DoctorOptions } from "./doctor-prompter.js";
export declare function maybeRepairLegacyCronStore(params: {
    cfg: OpenClawConfig;
    options: DoctorOptions;
    prompter: Pick<DoctorPrompter, "confirm">;
}): Promise<void>;
