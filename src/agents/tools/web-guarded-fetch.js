import { fetchWithSsrFGuard, withStrictGuardedFetchMode, withTrustedEnvProxyGuardedFetchMode, } from "../../infra/net/fetch-guard.js";
const WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY = {
    dangerouslyAllowPrivateNetwork: true,
    allowRfc2544BenchmarkRange: true,
};
function resolveTimeoutMs(params) {
    if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
        return params.timeoutMs;
    }
    if (typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)) {
        return params.timeoutSeconds * 1000;
    }
    return undefined;
}
export async function fetchWithWebToolsNetworkGuard(params) {
    const { timeoutSeconds, useEnvProxy, ...rest } = params;
    const resolved = {
        ...rest,
        timeoutMs: resolveTimeoutMs({ timeoutMs: rest.timeoutMs, timeoutSeconds }),
    };
    return fetchWithSsrFGuard(useEnvProxy
        ? withTrustedEnvProxyGuardedFetchMode(resolved)
        : withStrictGuardedFetchMode(resolved));
}
async function withWebToolsNetworkGuard(params, run) {
    const { response, finalUrl, release } = await fetchWithWebToolsNetworkGuard(params);
    try {
        return await run({ response, finalUrl });
    }
    finally {
        await release();
    }
}
export async function withTrustedWebToolsEndpoint(params, run) {
    return await withWebToolsNetworkGuard({
        ...params,
        policy: WEB_TOOLS_TRUSTED_NETWORK_SSRF_POLICY,
        useEnvProxy: true,
    }, run);
}
export async function withStrictWebToolsEndpoint(params, run) {
    return await withWebToolsNetworkGuard(params, run);
}
