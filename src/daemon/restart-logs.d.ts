import type { GatewayServiceEnv } from "./service-types.js";
export declare const GATEWAY_RESTART_LOG_FILENAME = "gateway-restart.log";
export declare function resolveGatewayLogPaths(env: GatewayServiceEnv): {
    logDir: string;
    stdoutPath: string;
    stderrPath: string;
};
export declare function resolveGatewayRestartLogPath(env: GatewayServiceEnv): string;
export declare function shellEscapeRestartLogValue(value: string): string;
export declare function renderPosixRestartLogSetup(env: GatewayServiceEnv): string;
export declare function renderCmdRestartLogSetup(env: GatewayServiceEnv): {
    lines: string[];
    quotedLogPath: string;
};
