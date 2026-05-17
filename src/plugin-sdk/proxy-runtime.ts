// Public runtime helpers for plugins that need to coordinate with OpenClaw's
// operator-managed external proxy lifecycle.
//
// Plugin code lives outside `src/**` and cannot import core internals
// directly; this barrel re-exports the narrow surface needed to carve
// loopback IPC out of the managed proxy.

export { registerManagedProxyBrowserCdpBypass } from "../infra/net/proxy/proxy-lifecycle.js";
