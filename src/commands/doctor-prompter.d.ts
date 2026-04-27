import { confirm, select } from "@clack/prompts";
import type { RuntimeEnv } from "../runtime.js";
import { type DoctorRepairMode } from "./doctor-repair-mode.js";
import type { DoctorOptions } from "./doctor.types.js";
export type { DoctorOptions } from "./doctor.types.js";
export type DoctorPrompter = {
    confirm: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
    confirmAutoFix: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
    confirmAggressiveAutoFix: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
    confirmRuntimeRepair: (params: Parameters<typeof confirm>[0]) => Promise<boolean>;
    select: <T>(params: Parameters<typeof select>[0], fallback: T) => Promise<T>;
    shouldRepair: boolean;
    shouldForce: boolean;
    repairMode: DoctorRepairMode;
};
export declare function createDoctorPrompter(params: {
    runtime: RuntimeEnv;
    options: DoctorOptions;
}): DoctorPrompter;
