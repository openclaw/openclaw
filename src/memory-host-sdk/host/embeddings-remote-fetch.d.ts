import type { SsrFPolicy } from "../../infra/net/ssrf.js";
export declare function fetchRemoteEmbeddingVectors(params: {
    url: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    fetchImpl?: typeof fetch;
    body: unknown;
    errorPrefix: string;
}): Promise<number[][]>;
