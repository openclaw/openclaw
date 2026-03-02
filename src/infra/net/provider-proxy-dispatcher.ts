import { Agent, EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ModelsConfig } from "../../config/types.models.js";
import { logDebug, logInfo } from "../../logger.js";

const PROXY_DIRECT = "direct";
const PROXY_ENV = "env";

/**
 * Routing dispatcher that directs HTTP requests based on destination hostname.
 *
 * - Providers with `proxy: "direct"` bypass all proxies.
 * - Providers with `proxy: "<url>"` route through the specified proxy.
 * - Everything else falls back to the system env proxy (EnvHttpProxyAgent).
 */
export class ProviderProxyRouter extends Agent {
  readonly #hostnameMap: Map<string, Dispatcher>;
  readonly #ownedDispatchers: Dispatcher[];
  readonly #fallback: Dispatcher;

  constructor(hostnameMap: Map<string, Dispatcher>, fallback: Dispatcher, owned: Dispatcher[]) {
    super();
    this.#hostnameMap = hostnameMap;
    this.#fallback = fallback;
    this.#ownedDispatchers = owned;
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = opts.origin;
    if (origin) {
      const hostname = extractHostname(typeof origin === "string" ? origin : origin.toString());
      const target = hostname ? this.#hostnameMap.get(hostname) : undefined;
      if (target) {
        return target.dispatch(opts, handler);
      }
    }
    return this.#fallback.dispatch(opts, handler);
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const d of this.#ownedDispatchers) {
      try {
        await d.close();
      } catch (err) {
        errors.push(err);
      }
    }
    try {
      await this.#fallback.close();
    } catch (err) {
      errors.push(err);
    }
    if (errors.length > 0) {
      logDebug(`[provider-proxy] errors during close: ${errors.map(String).join(", ")}`);
    }
    await super.close();
  }
}

function extractHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Build a {@link ProviderProxyRouter} from the models config.
 *
 * Returns `undefined` when no provider declares a custom `proxy` value,
 * meaning the default `EnvHttpProxyAgent` behaviour is sufficient.
 */
export function buildProviderProxyRouter(
  modelsConfig: ModelsConfig | undefined,
): ProviderProxyRouter | undefined {
  const providers = modelsConfig?.providers;
  if (!providers) {
    return undefined;
  }

  const hostnameToProxy = new Map<string, string>();
  for (const [providerId, providerCfg] of Object.entries(providers)) {
    if (!providerCfg) {
      continue;
    }
    const proxy = providerCfg.proxy?.trim();
    if (!proxy || proxy === PROXY_ENV) {
      continue;
    }

    const hostname = extractHostname(providerCfg.baseUrl);
    if (!hostname) {
      logDebug(
        `[provider-proxy] skipping provider "${providerId}": cannot extract hostname from baseUrl "${providerCfg.baseUrl}"`,
      );
      continue;
    }

    const existing = hostnameToProxy.get(hostname);
    if (existing && existing !== proxy) {
      logDebug(
        `[provider-proxy] hostname "${hostname}" has conflicting proxy values ("${existing}" vs "${proxy}"); last writer wins`,
      );
    }
    hostnameToProxy.set(hostname, proxy);
  }

  if (hostnameToProxy.size === 0) {
    return undefined;
  }

  const hostnameMap = new Map<string, Dispatcher>();
  const owned: Dispatcher[] = [];
  // Cache dispatchers by proxy URL so multiple hostnames sharing the same proxy reuse a single agent.
  const proxyAgentCache = new Map<string, Dispatcher>();

  let directAgent: Agent | undefined;

  for (const [hostname, proxy] of hostnameToProxy) {
    if (proxy === PROXY_DIRECT) {
      if (!directAgent) {
        directAgent = new Agent();
        owned.push(directAgent);
      }
      hostnameMap.set(hostname, directAgent);
      logInfo(`[provider-proxy] ${hostname} → direct (no proxy)`);
    } else {
      let agent = proxyAgentCache.get(proxy);
      if (!agent) {
        agent = new ProxyAgent(proxy);
        proxyAgentCache.set(proxy, agent);
        owned.push(agent);
      }
      hostnameMap.set(hostname, agent);
      logInfo(`[provider-proxy] ${hostname} → ${proxy}`);
    }
  }

  const fallback = new EnvHttpProxyAgent();
  return new ProviderProxyRouter(hostnameMap, fallback, owned);
}

/**
 * Build a routing dispatcher from config and install it as the global undici
 * dispatcher, replacing pi-ai's default `EnvHttpProxyAgent`.
 *
 * No-op when no provider declares a custom `proxy` value.
 */
export function installProviderProxyDispatcher(modelsConfig: ModelsConfig | undefined): void {
  const router = buildProviderProxyRouter(modelsConfig);
  if (router) {
    setGlobalDispatcher(router);
    logInfo("[provider-proxy] custom routing dispatcher installed");
  }
}
