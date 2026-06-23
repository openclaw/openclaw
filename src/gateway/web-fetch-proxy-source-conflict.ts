// Web fetch trusted-env-proxy source conflict detector.
// Warns when HTTP/HTTPS proxy env vars (HTTP_PROXY / HTTPS_PROXY and their
// lower-case forms) are set but tools.web.fetch.useTrustedEnvProxy is not
// enabled, so web_fetch silently uses direct connections instead of the
// configured proxy.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasEnvHttpProxyConfigured } from "../infra/net/proxy-env.js";

// Env vars listed in the warning text. Both upper- and lower-case forms are
// included so the diagnostic surfaces whichever names the operator actually
// set. The detection gate (whether to warn at all) delegates to the same
// HTTP(S)-only predicate used by the web_fetch runtime path
// (shouldUseEnvHttpProxyForUrl -> hasEnvHttpProxyConfigured), so the gate
// only matches env vars that the web_fetch dispatcher would actually
// consider (the useTrustedEnvProxy opt-in is then a separate guard below):
//   - lower-case HTTP/HTTPS env vars take precedence over upper-case,
//   - an empty lower-case value intentionally shadows the upper-case value,
//   - ALL_PROXY / all_proxy alone do NOT fire — the web_fetch dispatcher
//     (built with no explicit options) does not honor ALL_PROXY for HTTP/HTTPS
//     even when useTrustedEnvProxy is on, so warning about it would be
//     misleading remediation.
const SUPPORTED_ENV_VARS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;

// Doctor/audit/status warning shape for processes where HTTP(S)_PROXY env vars
// are set but tools.web.fetch.useTrustedEnvProxy is not enabled, so web_fetch
// silently uses direct connections and ignores the configured proxy.
type WebFetchProxySourceConflict = {
  checkId: "tools.web.fetch.env_proxy_without_use_trusted_env_proxy";
  title: string;
  detail: string;
  remediation: string;
  warningLines: string[];
  diagnostic: string;
};

/** Returns a warning when HTTP/HTTPS proxy env vars are present but web_fetch is not opted in to use them. */
export function resolveWebFetchProxySourceConflict(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): WebFetchProxySourceConflict | null {
  // Mirror the web_fetch runtime gate exactly: shouldUseEnvHttpProxyForUrl()
  // checks per-protocol with hasEnvHttpProxyConfigured(), which only reads
  // HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy (no ALL_PROXY).
  if (
    !hasEnvHttpProxyConfigured("http", params.env) &&
    !hasEnvHttpProxyConfigured("https", params.env)
  ) {
    return null;
  }

  if (params.cfg.tools?.web?.fetch?.useTrustedEnvProxy === true) {
    return null;
  }

  const presentEnvVars = SUPPORTED_ENV_VARS.filter(
    (name) => normalizeOptionalString(params.env[name]) !== undefined,
  );
  const envList = presentEnvVars.join(", ");
  const title = `${envList} set without tools.web.fetch.useTrustedEnvProxy`;
  const detail =
    `Detected ${envList} in the process environment, but tools.web.fetch.useTrustedEnvProxy is not enabled, ` +
    "so web_fetch will use direct connections and ignore the configured proxy. " +
    "This can cause silent timeouts on networks that block direct egress.";
  const remediation =
    "Set tools.web.fetch.useTrustedEnvProxy: true in openclaw.json if web_fetch should route through the proxy. " +
    "Note: this lets the proxy resolve DNS for web_fetch instead of local DNS pinning, so only enable when the proxy enforces outbound policy.";

  return {
    checkId: "tools.web.fetch.env_proxy_without_use_trusted_env_proxy",
    title,
    detail,
    remediation,
    warningLines: [`- WARNING: ${title}.`, `  ${detail}`, `  Fix: ${remediation}`],
    diagnostic: `${title}: ${remediation}`,
  };
}
