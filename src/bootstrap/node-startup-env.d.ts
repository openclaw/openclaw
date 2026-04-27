import { type EnvMap } from "./node-extra-ca-certs.js";
export type NodeStartupTlsEnvironment = {
    NODE_EXTRA_CA_CERTS?: string;
    NODE_USE_SYSTEM_CA?: string;
};
export declare function resolveNodeStartupTlsEnvironment(params?: {
    env?: EnvMap;
    platform?: NodeJS.Platform;
    execPath?: string;
    includeDarwinDefaults?: boolean;
    accessSync?: (path: string, mode?: number) => void;
}): NodeStartupTlsEnvironment;
