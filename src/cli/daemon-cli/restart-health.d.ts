import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import { type PortUsage } from "../../infra/ports.js";
export declare const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 60000;
export declare const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
export declare const DEFAULT_RESTART_HEALTH_ATTEMPTS: number;
export type GatewayRestartWaitOutcome = "healthy" | "stale-pids" | "stopped-free" | "timeout";
export type GatewayRestartSnapshot = {
    runtime: GatewayServiceRuntime;
    portUsage: PortUsage;
    healthy: boolean;
    staleGatewayPids: number[];
    waitOutcome?: GatewayRestartWaitOutcome;
    elapsedMs?: number;
};
export type GatewayPortHealthSnapshot = {
    portUsage: PortUsage;
    healthy: boolean;
};
export declare function inspectGatewayRestart(params: {
    service: GatewayService;
    port: number;
    env?: NodeJS.ProcessEnv;
    includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot>;
export declare function waitForGatewayHealthyRestart(params: {
    service: GatewayService;
    port: number;
    attempts?: number;
    delayMs?: number;
    env?: NodeJS.ProcessEnv;
    includeUnknownListenersAsStale?: boolean;
}): Promise<GatewayRestartSnapshot>;
export declare function waitForGatewayHealthyListener(params: {
    port: number;
    attempts?: number;
    delayMs?: number;
}): Promise<GatewayPortHealthSnapshot>;
export declare function renderRestartDiagnostics(snapshot: GatewayRestartSnapshot): string[];
export declare function renderGatewayPortHealthDiagnostics(snapshot: GatewayPortHealthSnapshot): string[];
export declare function terminateStaleGatewayPids(pids: number[]): Promise<number[]>;
