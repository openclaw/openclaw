import { ssrfPolicyFromHttpBaseUrlAllowedHostname, type SsrFPolicy } from "../../infra/net/ssrf.js";
export declare const buildRemoteBaseUrlPolicy: typeof ssrfPolicyFromHttpBaseUrlAllowedHostname;
export declare function withRemoteHttpResponse<T>(params: {
    url: string;
    init?: RequestInit;
    ssrfPolicy?: SsrFPolicy;
    fetchImpl?: typeof fetch;
    auditContext?: string;
    onResponse: (response: Response) => Promise<T>;
}): Promise<T>;
