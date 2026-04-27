import { type OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions, DoctorPrompter } from "./doctor-prompter.js";
export declare function maybeRepairGatewayServiceConfig(cfg: OpenClawConfig, mode: "local" | "remote", runtime: RuntimeEnv, prompter: DoctorPrompter): Promise<void>;
export declare function maybeScanExtraGatewayServices(options: DoctorOptions, runtime: RuntimeEnv, prompter: DoctorPrompter): Promise<void>;
