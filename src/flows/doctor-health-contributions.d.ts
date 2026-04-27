import type { probeGatewayMemoryStatus } from "../commands/doctor-gateway-health.js";
import type { DoctorOptions, DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { buildGatewayConnectionDetails } from "../gateway/call.js";
import type { RuntimeEnv } from "../runtime.js";
import type { FlowContribution } from "./types.js";
export type DoctorFlowMode = "local" | "remote";
export type DoctorConfigResult = {
    cfg: OpenClawConfig;
    path?: string;
    shouldWriteConfig?: boolean;
    sourceConfigValid?: boolean;
};
export type DoctorHealthFlowContext = {
    runtime: RuntimeEnv;
    options: DoctorOptions;
    prompter: DoctorPrompter;
    configResult: DoctorConfigResult;
    cfg: OpenClawConfig;
    cfgForPersistence: OpenClawConfig;
    sourceConfigValid: boolean;
    configPath: string;
    gatewayDetails?: ReturnType<typeof buildGatewayConnectionDetails>;
    healthOk?: boolean;
    gatewayMemoryProbe?: Awaited<ReturnType<typeof probeGatewayMemoryStatus>>;
};
export type DoctorHealthContribution = FlowContribution & {
    kind: "core";
    surface: "health";
    run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};
export declare function resolveDoctorMode(cfg: OpenClawConfig): DoctorFlowMode;
export declare function resolveDoctorHealthContributions(): DoctorHealthContribution[];
export declare function runDoctorHealthContributions(ctx: DoctorHealthFlowContext): Promise<void>;
