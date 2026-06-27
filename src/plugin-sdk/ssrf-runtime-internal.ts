// Transitional compatibility surface for bundled plugins that need managed
// proxy bypass helpers. Re-exports from infra until a generic SDK seam exists.

export { fetchConfiguredLocalOriginWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { registerManagedProxyBrowserCdpBypass } from "../infra/net/proxy/proxy-lifecycle.js";
