import { fetchWithSsrFGuard, type GuardedFetchMode } from "../../infra/net/fetch-guard.js";
import { hasProxyEnvConfigured } from "../../infra/net/proxy-env.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";

export function buildRemoteBaseUrlPolicy(baseUrl: string): SsrFPolicy | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    // Keep policy tied to the configured host so private operator endpoints
    // continue to work, while cross-host redirects stay blocked.
    return { allowedHostnames: [parsed.hostname] };
  } catch {
    return undefined;
  }
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: SsrFPolicy;
  fetchImpl?: typeof fetch;
  auditContext?: string;
  mode?: GuardedFetchMode;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  // When env proxy vars are set (e.g. CrabTrap) and the caller hasn't
  // explicitly chosen a mode, use trusted_env_proxy so the request routes
  // through the operator-configured proxy instead of connecting directly.
  const mode: GuardedFetchMode | undefined =
    params.mode ?? (hasProxyEnvConfigured() ? "trusted_env_proxy" : undefined);
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    policy: params.ssrfPolicy,
    auditContext: params.auditContext ?? "memory-remote",
    ...(mode ? { mode } : {}),
  });
  try {
    return await params.onResponse(response);
  } finally {
    await release();
  }
}
