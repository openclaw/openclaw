import type { GatewayServiceRuntime } from "./service-runtime.js";
import type { GatewayServiceCommandConfig, GatewayServiceControlArgs, GatewayServiceEnv, GatewayServiceEnvArgs, GatewayServiceInstallArgs, GatewayServiceManageArgs, GatewayServiceRestartResult, GatewayServiceStartResult, GatewayServiceStageArgs, GatewayServiceState } from "./service-types.js";
export type { GatewayServiceCommandConfig, GatewayServiceControlArgs, GatewayServiceEnv, GatewayServiceEnvArgs, GatewayServiceInstallArgs, GatewayServiceManageArgs, GatewayServiceRestartResult, GatewayServiceStartResult, GatewayServiceStageArgs, GatewayServiceState, } from "./service-types.js";
export type GatewayService = {
    label: string;
    loadedText: string;
    notLoadedText: string;
    stage: (args: GatewayServiceStageArgs) => Promise<void>;
    install: (args: GatewayServiceInstallArgs) => Promise<void>;
    uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
    stop: (args: GatewayServiceControlArgs) => Promise<void>;
    restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
    isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
    readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
    readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};
export declare function readGatewayServiceState(service: GatewayService, args?: GatewayServiceEnvArgs): Promise<GatewayServiceState>;
export declare function startGatewayService(service: GatewayService, args: GatewayServiceControlArgs): Promise<GatewayServiceStartResult>;
export declare function describeGatewayServiceRestart(serviceNoun: string, result: GatewayServiceRestartResult): {
    scheduled: boolean;
    daemonActionResult: "restarted" | "scheduled";
    message: string;
    progressMessage: string;
};
export declare function resolveGatewayService(): GatewayService;
