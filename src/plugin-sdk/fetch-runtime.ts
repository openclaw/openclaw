// Public fetch/proxy helpers for plugins that need wrapped fetch behavior.

export { resolveFetch, wrapFetchWithAbortSignal } from "../infra/fetch.js";
export {
  fetchWithResponseRelease,
  type FetchWithResponseReleaseOptions,
  type FetchWithResponseReleaseResult,
} from "../infra/net/egress-fetch.js";
export {
  createHttp1Agent,
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
} from "../infra/net/undici-runtime.js";
export {
  addActiveManagedProxyTlsOptions,
  resolveActiveManagedProxyTlsOptions,
} from "../infra/net/proxy/managed-proxy-undici.js";
export {
  createNodeProxyAgent,
  type CreateNodeProxyAgentOptions,
} from "../infra/net/node-proxy-agent.js";
export {
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
  shouldUseEnvHttpProxyForUrl,
} from "../infra/net/proxy-env.js";
export { getProxyUrlFromFetch, makeProxyFetch } from "../infra/net/proxy-fetch.js";
