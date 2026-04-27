import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export declare function maybeRepairLegacyOAuthProfileIds(cfg: OpenClawConfig, prompter: DoctorPrompter): Promise<OpenClawConfig>;
