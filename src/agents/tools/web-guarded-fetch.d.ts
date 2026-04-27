import { type GuardedFetchOptions, type GuardedFetchResult } from "../../infra/net/fetch-guard.js";
type WebToolGuardedFetchOptions = Omit<GuardedFetchOptions, "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"> & {
    timeoutSeconds?: number;
    useEnvProxy?: boolean;
};
type WebToolEndpointFetchOptions = Omit<WebToolGuardedFetchOptions, "policy" | "useEnvProxy">;
export declare function fetchWithWebToolsNetworkGuard(params: WebToolGuardedFetchOptions): Promise<GuardedFetchResult>;
export declare function withTrustedWebToolsEndpoint<T>(params: WebToolEndpointFetchOptions, run: (result: {
    response: Response;
    finalUrl: string;
}) => Promise<T>): Promise<T>;
export declare function withStrictWebToolsEndpoint<T>(params: WebToolEndpointFetchOptions, run: (result: {
    response: Response;
    finalUrl: string;
}) => Promise<T>): Promise<T>;
export {};
