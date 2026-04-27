import { fetchWithSsrFGuard, GUARDED_FETCH_MODE } from "../../infra/net/fetch-guard.js";
import { shouldUseEnvHttpProxyForUrl } from "../../infra/net/proxy-env.js";
import { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "../../infra/net/ssrf.js";
export const buildRemoteBaseUrlPolicy = ssrfPolicyFromHttpBaseUrlAllowedHostname;
export async function withRemoteHttpResponse(params) {
    const { response, release } = await fetchWithSsrFGuard({
        url: params.url,
        fetchImpl: params.fetchImpl,
        init: params.init,
        policy: params.ssrfPolicy,
        auditContext: params.auditContext ?? "memory-remote",
        ...(shouldUseEnvHttpProxyForUrl(params.url)
            ? { mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY }
            : {}),
    });
    try {
        return await params.onResponse(response);
    }
    finally {
        await release();
    }
}
