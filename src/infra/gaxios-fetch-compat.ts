import type { ConnectionOptions } from "node:tls";
import { Gaxios } from "gaxios";
import type { Dispatcher } from "undici";
import { Agent as UndiciAgent, ProxyAgent } from "undici";

type ProxyRule = RegExp | URL | string;
type TlsCert = ConnectionOptions["cert"];
type TlsKey = ConnectionOptions["key"];

type GaxiosFetchRequestInit = RequestInit & {
  agent?: unknown;
  cert?: TlsCert;
  dispatcher?: Dispatcher;
  fetchImplementation?: typeof fetch;
  key?: TlsKey;
  noProxy?: ProxyRule[];
  proxy?: string | URL;
};

type ProxyAgentLike = {
  connectOpts?: { cert?: TlsCert; key?: TlsKey };
  proxy: URL;
};

type TlsAgentLike = {
  options?: { cert?: TlsCert; key?: TlsKey };
};

type GaxiosPrototype = {
  _defaultAdapter: (this: Gaxios, config: GaxiosFetchRequestInit) => Promise<unknown>;
};

let installState: "not-installed" | "installed" = "not-installed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasDispatcher(value: unknown): value is Dispatcher {
  return isRecord(value) && typeof value.dispatch === "function";
}

function hasProxyAgentShape(value: unknown): value is ProxyAgentLike {
  return isRecord(value) && value.proxy instanceof URL;
}

function hasTlsAgentShape(value: unknown): value is TlsAgentLike {
  return isRecord(value) && isRecord(value.options);
}

function resolveTlsOptions(
  init: GaxiosFetchRequestInit,
  url: URL,
): { cert?: TlsCert; key?: TlsKey } {
  const explicit = {
    cert: init.cert,
    key: init.key,
  };
  if (explicit.cert !== undefined || explicit.key !== undefined) {
    return explicit;
  }

  const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
  if (hasProxyAgentShape(agent)) {
    return {
      cert: agent.connectOpts?.cert,
      key: agent.connectOpts?.key,
    };
  }
  if (hasTlsAgentShape(agent)) {
    return {
      cert: agent.options?.cert,
      key: agent.options?.key,
    };
  }
  return {};
}

function urlMayUseProxy(url: URL, noProxy: ProxyRule[] = []): boolean {
  const rules = [...noProxy];
  const envRules = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") ?? [];
  for (const rule of envRules) {
    const trimmed = rule.trim();
    if (trimmed.length > 0) {
      rules.push(trimmed);
    }
  }

  for (const rule of rules) {
    if (rule instanceof RegExp) {
      if (rule.test(url.toString())) {
        return false;
      }
      continue;
    }
    if (rule instanceof URL) {
      if (rule.origin === url.origin) {
        return false;
      }
      continue;
    }
    if (rule.startsWith("*.") || rule.startsWith(".")) {
      const cleanedRule = rule.replace(/^\*\./, ".");
      if (url.hostname.endsWith(cleanedRule)) {
        return false;
      }
      continue;
    }
    if (rule === url.origin || rule === url.hostname || rule === url.href) {
      return false;
    }
  }

  return true;
}

function resolveProxyUri(init: GaxiosFetchRequestInit, url: URL): string | undefined {
  if (init.proxy) {
    const proxyUri = String(init.proxy);
    return urlMayUseProxy(url, init.noProxy) ? proxyUri : undefined;
  }

  const envProxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!envProxy) {
    return undefined;
  }

  return urlMayUseProxy(url, init.noProxy) ? envProxy : undefined;
}

function buildDispatcher(init: GaxiosFetchRequestInit, url: URL): Dispatcher | undefined {
  if (init.dispatcher) {
    return init.dispatcher;
  }

  const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
  if (hasDispatcher(agent)) {
    return agent;
  }

  const { cert, key } = resolveTlsOptions(init, url);
  const proxyUri =
    resolveProxyUri(init, url) ?? (hasProxyAgentShape(agent) ? String(agent.proxy) : undefined);
  if (proxyUri) {
    return new ProxyAgent({
      requestTls: cert !== undefined || key !== undefined ? { cert, key } : undefined,
      uri: proxyUri,
    });
  }

  if (cert !== undefined || key !== undefined) {
    return new UndiciAgent({
      connect: { cert, key },
    });
  }

  return undefined;
}

export function createGaxiosCompatFetch(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const gaxiosInit = (init ?? {}) as GaxiosFetchRequestInit;
    const requestUrl =
      input instanceof Request
        ? new URL(input.url)
        : new URL(typeof input === "string" ? input : input.toString());
    const dispatcher = buildDispatcher(gaxiosInit, requestUrl);

    const nextInit: RequestInit = { ...gaxiosInit };
    delete (nextInit as GaxiosFetchRequestInit).agent;
    delete (nextInit as GaxiosFetchRequestInit).cert;
    delete (nextInit as GaxiosFetchRequestInit).fetchImplementation;
    delete (nextInit as GaxiosFetchRequestInit).key;
    delete (nextInit as GaxiosFetchRequestInit).noProxy;
    delete (nextInit as GaxiosFetchRequestInit).proxy;

    if (dispatcher) {
      (nextInit as RequestInit & { dispatcher: Dispatcher }).dispatcher = dispatcher;
    }

    return baseFetch(input, nextInit);
  };
}

export function installGaxiosFetchCompat(): void {
  if (installState === "installed" || typeof globalThis.fetch !== "function") {
    return;
  }

  const prototype = Gaxios.prototype as unknown as GaxiosPrototype;
  const originalDefaultAdapter = prototype._defaultAdapter;
  const compatFetch = createGaxiosCompatFetch();

  prototype._defaultAdapter = function patchedDefaultAdapter(
    this: Gaxios,
    config: GaxiosFetchRequestInit,
  ): Promise<unknown> {
    if (config.fetchImplementation) {
      return originalDefaultAdapter.call(this, config);
    }
    return originalDefaultAdapter.call(this, {
      ...config,
      fetchImplementation: compatFetch,
    });
  };

  installState = "installed";
}
