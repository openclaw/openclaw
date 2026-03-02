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
  readonly #hostMap: Map<string, Dispatcher>;
  readonly #ownedDispatchers: Dispatcher[];
  readonly #fallback: Dispatcher;

  constructor(hostMap: Map<string, Dispatcher>, fallback: Dispatcher, owned: Dispatcher[]) {
    super();
    this.#hostMap = hostMap;
    this.#fallback = fallback;
    this.#ownedDispatchers = owned;
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = opts.origin;
    if (origin) {
      const host = extractHost(typeof origin === "string" ? origin : origin.toString());
      const target = host ? this.#hostMap.get(host) : undefined;
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

function extractHost(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    return url.host; // hostname:port (port omitted when default for the protocol)
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

  const hostToProxy = new Map<string, string>();
  for (const [providerId, providerCfg] of Object.entries(providers)) {
    if (!providerCfg) {
      continue;
    }
    const proxy = providerCfg.proxy?.trim();
    if (!proxy || proxy === PROXY_ENV) {
      continue;
    }

    const host = extractHost(providerCfg.baseUrl);
    if (!host) {
      logDebug(
        `[provider-proxy] skipping provider "${providerId}": cannot extract host from baseUrl "${providerCfg.baseUrl}"`,
      );
      continue;
    }

    const existing = hostToProxy.get(host);
    if (existing && existing !== proxy) {
      logDebug(
        `[provider-proxy] host "${host}" has conflicting proxy values ("${existing}" vs "${proxy}"); last writer wins`,
      );
    }
    hostToProxy.set(host, proxy);
  }

  if (hostToProxy.size === 0) {
    return undefined;
  }

  const hostMap = new Map<string, Dispatcher>();
  const owned: Dispatcher[] = [];
  const proxyAgentCache = new Map<string, Dispatcher>();

  let directAgent: Agent | undefined;

  for (const [host, proxy] of hostToProxy) {
    if (proxy === PROXY_DIRECT) {
      if (!directAgent) {
        directAgent = new Agent();
        owned.push(directAgent);
      }
      hostMap.set(host, directAgent);
      logInfo(`[provider-proxy] ${host} → direct (no proxy)`);
    } else {
      let agent = proxyAgentCache.get(proxy);
      if (!agent) {
        agent = new ProxyAgent(proxy);
        proxyAgentCache.set(proxy, agent);
        owned.push(agent);
      }
      hostMap.set(host, agent);
      logInfo(`[provider-proxy] ${host} → ${proxy}`);
    }
  }

  const fallback = new EnvHttpProxyAgent();
  return new ProviderProxyRouter(hostMap, fallback, owned);
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
