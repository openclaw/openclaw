import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export declare function maybeRepairSandboxImages(cfg: OpenClawConfig, runtime: RuntimeEnv, prompter: DoctorPrompter): Promise<OpenClawConfig>;
export declare function noteSandboxScopeWarnings(cfg: OpenClawConfig): void;
