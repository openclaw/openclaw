import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type BundledRuntimeDepsInstallParams } from "../plugins/bundled-runtime-deps.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export declare function maybeRepairBundledPluginRuntimeDeps(params: {
    runtime: RuntimeEnv;
    prompter: DoctorPrompter;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    packageRoot?: string | null;
    includeConfiguredChannels?: boolean;
    installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): Promise<void>;
