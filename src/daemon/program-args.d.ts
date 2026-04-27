type GatewayProgramArgs = {
    programArguments: string[];
    workingDirectory?: string;
};
type GatewayRuntimePreference = "auto" | "node" | "bun";
export declare function resolveGatewayProgramArguments(params: {
    port: number;
    dev?: boolean;
    runtime?: GatewayRuntimePreference;
    nodePath?: string;
}): Promise<GatewayProgramArgs>;
export declare function resolveNodeProgramArguments(params: {
    host: string;
    port: number;
    tls?: boolean;
    tlsFingerprint?: string;
    nodeId?: string;
    displayName?: string;
    dev?: boolean;
    runtime?: GatewayRuntimePreference;
    nodePath?: string;
}): Promise<GatewayProgramArgs>;
export {};
