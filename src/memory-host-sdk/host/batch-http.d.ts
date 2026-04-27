import type { SsrFPolicy } from "../../infra/net/ssrf.js";
export declare function postJsonWithRetry<T>(params: {
    url: string;
    headers: Record<string, string>;
    ssrfPolicy?: SsrFPolicy;
    fetchImpl?: typeof fetch;
    body: unknown;
    errorPrefix: string;
}): Promise<T>;
