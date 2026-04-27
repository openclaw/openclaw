import { type DebugProxySettings } from "./env.js";
export declare function isDebugProxyGlobalFetchPatchInstalled(): boolean;
export declare function initializeDebugProxyCapture(mode: string, resolved?: DebugProxySettings): void;
export declare function finalizeDebugProxyCapture(resolved?: DebugProxySettings): void;
export declare function captureHttpExchange(params: {
    url: string;
    method: string;
    requestHeaders?: Headers | Record<string, string> | undefined;
    requestBody?: BodyInit | Buffer | string | null;
    response: Response;
    transport?: "http" | "sse";
    flowId?: string;
    meta?: Record<string, unknown>;
}): void;
export declare function captureWsEvent(params: {
    url: string;
    direction: "outbound" | "inbound" | "local";
    kind: "ws-open" | "ws-frame" | "ws-close" | "error";
    flowId: string;
    payload?: string | Buffer;
    closeCode?: number;
    errorText?: string;
    meta?: Record<string, unknown>;
}): void;
