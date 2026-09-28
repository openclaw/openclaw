// Private transport helpers for bundled plugins.
// Host-owned request fences and managed proxy bypass stay off the public SDK.

export { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
export { fetchConfiguredLocalOriginWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { registerManagedProxyBrowserCdpBypass } from "../infra/net/proxy/proxy-lifecycle.js";
