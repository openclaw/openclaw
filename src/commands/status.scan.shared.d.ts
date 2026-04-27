import type { OpenClawConfig } from "../config/types.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import type { probeGateway as probeGatewayFn } from "../gateway/probe.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
import { pickGatewaySelfPresence } from "./gateway-presence.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";
export type MemoryStatusSnapshot = MemoryProviderStatus & {
    agentId: string;
};
export type MemoryPluginStatus = {
    enabled: boolean;
    slot: string | null;
    reason?: string;
};
export type GatewayProbeSnapshot = {
    gatewayConnection: ReturnType<typeof buildGatewayConnectionDetailsWithResolvers>;
    remoteUrlMissing: boolean;
    gatewayMode: "local" | "remote";
    gatewayProbeAuth: {
        token?: string;
        password?: string;
    };
    gatewayProbeAuthWarning?: string;
    gatewayProbe: Awaited<ReturnType<typeof probeGatewayFn>> | null;
    gatewayReachable: boolean;
    gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
    gatewayCallOverrides?: {
        url: string;
        token?: string;
        password?: string;
    };
};
export declare function hasExplicitMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean;
export declare function resolveMemoryPluginStatus(cfg: OpenClawConfig): MemoryPluginStatus;
export declare function resolveGatewayProbeSnapshot(params: {
    cfg: OpenClawConfig;
    opts: {
        timeoutMs?: number;
        all?: boolean;
        skipProbe?: boolean;
        detailLevel?: "none" | "presence" | "full";
        probeWhenRemoteUrlMissing?: boolean;
        resolveAuthWhenRemoteUrlMissing?: boolean;
        mergeAuthWarningIntoProbeError?: boolean;
    };
}): Promise<GatewayProbeSnapshot>;
export declare function buildTailscaleHttpsUrl(params: {
    tailscaleMode: string;
    tailscaleDns: string | null;
    controlUiBasePath?: string;
}): string | null;
export declare function resolveSharedMemoryStatusSnapshot(params: {
    cfg: OpenClawConfig;
    agentStatus: {
        defaultId?: string | null;
    };
    memoryPlugin: MemoryPluginStatus;
    resolveMemoryConfig: (cfg: OpenClawConfig, agentId: string) => {
        store: {
            path: string;
        };
    } | null;
    getMemorySearchManager: (params: {
        cfg: OpenClawConfig;
        agentId: string;
        purpose: "status";
    }) => Promise<{
        manager: {
            probeVectorAvailability(): Promise<boolean>;
            status(): MemoryProviderStatus;
            close?(): Promise<void>;
        } | null;
    }>;
    requireDefaultStore?: (agentId: string) => string | null;
}): Promise<MemoryStatusSnapshot | null>;
