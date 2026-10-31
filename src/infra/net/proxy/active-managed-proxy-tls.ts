import { resolveEnvHttpProxyUrl } from "../proxy-env.js";
import { getActiveManagedProxyTlsOptions, getActiveManagedProxyUrl } from "./active-proxy-state.js";
import {
  loadManagedProxyTlsOptionsSync,
  resolveManagedProxyCaFileForUrl,
  type ManagedProxyTlsOptions,
} from "./proxy-tls.js";

type ResolveActiveManagedProxyTlsOptionsParams = {
  proxyUrl?: string;
  env?: NodeJS.ProcessEnv;
};

function normalizeProxyUrl(value: string | undefined): string | undefined {
  return value ? URL.parse(value)?.href : undefined;
}

function resolveManagedProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const activeProxyUrl = getActiveManagedProxyUrl();
  if (activeProxyUrl) {
    return activeProxyUrl.href;
  }
  if (env.OPENCLAW_PROXY_ACTIVE !== "1") {
    return undefined;
  }
  // Child processes inherit only env, so recover the managed proxy URL from
  // HTTPS proxy settings when the active in-process registration is absent.
  return normalizeProxyUrl(resolveEnvHttpProxyUrl("https", env));
}

/** Resolves managed proxy TLS trust only when the target proxy is OpenClaw's active proxy. */
export function resolveActiveManagedProxyTlsOptions(
  params?: ResolveActiveManagedProxyTlsOptionsParams,
): ManagedProxyTlsOptions | undefined {
  const env = params?.env ?? process.env;
  const managedProxyUrl = resolveManagedProxyUrl(env);
  const targetProxyUrl = normalizeProxyUrl(
    params?.proxyUrl ?? resolveEnvHttpProxyUrl("https", env),
  );
  if (!managedProxyUrl || targetProxyUrl !== managedProxyUrl) {
    return undefined;
  }
  const activeProxyTls = getActiveManagedProxyTlsOptions();
  if (activeProxyTls) {
    return activeProxyTls;
  }
  const proxyCaFile = resolveManagedProxyCaFileForUrl({
    proxyUrl: managedProxyUrl,
    caFileOverride: env.OPENCLAW_PROXY_CA_FILE,
  });
  try {
    return loadManagedProxyTlsOptionsSync(proxyCaFile);
  } catch {
    // Missing inherited CA files should not break non-managed or caller-owned proxies.
    return undefined;
  }
}
