import type { Writable } from "node:stream";
import type { GatewayServiceRestartResult } from "../../daemon/service-types.js";
import type { GatewayService } from "../../daemon/service.js";
type DaemonLifecycleOptions = {
    json?: boolean;
};
type RestartPostCheckContext = {
    json: boolean;
    stdout: Writable;
    warnings: string[];
    fail: (message: string, hints?: string[]) => void;
};
type ServiceRecoveryResult = {
    result: "started" | "stopped" | "restarted";
    message?: string;
    warnings?: string[];
    loaded?: boolean;
};
type ServiceRecoveryContext = {
    json: boolean;
    stdout: Writable;
    fail: (message: string, hints?: string[]) => void;
};
export declare function runServiceUninstall(params: {
    serviceNoun: string;
    service: GatewayService;
    opts?: DaemonLifecycleOptions;
    stopBeforeUninstall: boolean;
    assertNotLoadedAfterUninstall: boolean;
}): Promise<void>;
export declare function runServiceStart(params: {
    serviceNoun: string;
    service: GatewayService;
    renderStartHints: () => string[];
    opts?: DaemonLifecycleOptions;
    onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult | null>;
}): Promise<void>;
export declare function runServiceStop(params: {
    serviceNoun: string;
    service: GatewayService;
    opts?: DaemonLifecycleOptions;
    onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult | null>;
}): Promise<void>;
export declare function runServiceRestart(params: {
    serviceNoun: string;
    service: GatewayService;
    renderStartHints: () => string[];
    opts?: DaemonLifecycleOptions;
    checkTokenDrift?: boolean;
    postRestartCheck?: (ctx: RestartPostCheckContext) => Promise<GatewayServiceRestartResult | void>;
    onNotLoaded?: (ctx: ServiceRecoveryContext) => Promise<ServiceRecoveryResult | null>;
}): Promise<boolean>;
export {};
