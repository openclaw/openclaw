export type NodeHostGatewayConfig = {
    host?: string;
    port?: number;
    tls?: boolean;
    tlsFingerprint?: string;
};
export type NodeHostConfig = {
    version: 1;
    nodeId: string;
    token?: string;
    displayName?: string;
    gateway?: NodeHostGatewayConfig;
};
export declare function loadNodeHostConfig(): Promise<NodeHostConfig | null>;
export declare function saveNodeHostConfig(config: NodeHostConfig): Promise<void>;
export declare function ensureNodeHostConfig(): Promise<NodeHostConfig>;
