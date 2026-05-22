// Private local-only SSRF runtime helpers for bundled OpenClaw code.
// Keep managed proxy bypass capabilities out of the public plugin SDK surface.

export { fetchConfiguredLocalOriginWithSsrFGuard } from "../infra/net/fetch-guard.js";
