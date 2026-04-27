import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
type LegacyManifestContractMigration = {
    manifestPath: string;
    pluginId: string;
    nextRaw: Record<string, unknown>;
    changeLines: string[];
};
export declare function collectLegacyPluginManifestContractMigrations(params?: {
    env?: NodeJS.ProcessEnv;
}): LegacyManifestContractMigration[];
export declare function maybeRepairLegacyPluginManifestContracts(params: {
    env?: NodeJS.ProcessEnv;
    runtime: RuntimeEnv;
    prompter: DoctorPrompter;
    note?: typeof note;
}): Promise<void>;
export {};
