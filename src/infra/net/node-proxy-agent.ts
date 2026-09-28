// Node proxy agent helpers adapt env or explicit proxy settings for libraries
// that need node:http Agent instances.
import type { Agent as HttpAgent, AgentOptions as HttpAgentOptions } from "node:http";
import type { Agent as HttpsAgent, AgentOptions as HttpsAgentOptions } from "node:https";
import { createRequire } from "node:module";
import { isIPv6 } from "node:net";
import { matchesNoProxy, resolveEnvHttpProxyAgentOptions } from "./proxy-env.js";
import { resolveActiveManagedProxyTlsOptions } from "./proxy/active-managed-proxy-tls.js";

const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
  "Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

type NodeProxyProtocol = "http" | "https";
type ProxylineCreateAmbientNodeProxyAgent =
  typeof import("@openclaw/proxyline").createAmbientNodeProxyAgent;
type ProxylineNodeAgent = NonNullable<ReturnType<ProxylineCreateAmbientNodeProxyAgent>>;
type ProxylineAgentOptions = NonNullable<Parameters<ProxylineCreateAmbientNodeProxyAgent>[0]>;
type ProxylineEnvSnapshot = NonNullable<ProxylineAgentOptions["env"]>;
type ProxylineTlsOptions = ProxylineAgentOptions["proxyTls"];
type ProxylineProxyConnectOptions = import("@openclaw/proxyline").ProxyConnectOptions;
type NodeProxyAgentOptions = HttpAgentOptions & HttpsAgentOptions;
type NodeProxyAgentWithOptions = HttpAgent & {
  keepAlive: boolean;
  keepAliveMsecs: number;
  maxFreeSockets: number;
  maxSockets: number;
  maxTotalSockets: number;
  options?: NodeProxyAgentOptions;
  scheduling?: "fifo" | "lifo";
  timeout?: number;
};

const require = createRequire(import.meta.url);

/** Selects either ambient env proxy resolution or a caller-supplied fixed proxy URL. */
export type CreateNodeProxyAgentOptions =
  | {
      mode: "env";
      /** Omit when the library selects destinations; NO_PROXY is checked per request. */
      targetUrl?: string | URL;
      protocol?: NodeProxyProtocol;
      agentOptions?: NodeProxyAgentOptions;
      proxyConnect?: ProxylineProxyConnectOptions;
    }
  | {
      mode: "explicit";
      proxyUrl: string | URL;
      protocol?: NodeProxyProtocol;
      agentOptions?: NodeProxyAgentOptions;
      proxyConnect?: ProxylineProxyConnectOptions;
    };

function proxyUrlWithDefaultScheme(proxyUrl: string, protocol: NodeProxyProtocol): URL {
  const withScheme = proxyUrl.includes("://") ? proxyUrl : `${protocol}://${proxyUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    // URL parse errors retain the input, which can contain proxy credentials.
    throw new Error("Invalid proxy URL. Use an HTTP or HTTPS proxy URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${parsed.protocol}`);
  }
  return parsed;
}

function fixedProxyEnv(proxyUrl: URL): ProxylineEnvSnapshot {
  const href = proxyUrl.href;
  // Proxyline's ambient agent only reads env-shaped input. Pin both request
  // scheme slots to the explicit URL and clear bypass rules for a fixed agent.
  return {
    HTTP_PROXY: href,
    HTTPS_PROXY: href,
    ALL_PROXY: undefined,
    NO_PROXY: undefined,
    http_proxy: undefined,
    https_proxy: undefined,
    all_proxy: undefined,
    no_proxy: undefined,
  };
}

function loadProxyline(): typeof import("@openclaw/proxyline") {
  return require("@openclaw/proxyline") as typeof import("@openclaw/proxyline");
}

function applyNodeAgentOptions(agent: HttpAgent, options: NodeProxyAgentOptions | undefined): void {
  if (options === undefined) {
    return;
  }
  const agentWithOptions = agent as NodeProxyAgentWithOptions;
  agentWithOptions.options = {
    ...agentWithOptions.options,
    ...options,
  };
  if (typeof options.keepAlive === "boolean") {
    agentWithOptions.keepAlive = options.keepAlive;
  }
  if (typeof options.keepAliveMsecs === "number") {
    agentWithOptions.keepAliveMsecs = options.keepAliveMsecs;
  }
  if (typeof options.maxFreeSockets === "number") {
    agentWithOptions.maxFreeSockets = options.maxFreeSockets;
  }
  if (typeof options.maxSockets === "number") {
    agentWithOptions.maxSockets = options.maxSockets;
  }
  if (typeof options.maxTotalSockets === "number") {
    agentWithOptions.maxTotalSockets = options.maxTotalSockets;
  }
  if (options.scheduling === "fifo" || options.scheduling === "lifo") {
    agentWithOptions.scheduling = options.scheduling;
  }
  if (typeof options.timeout === "number") {
    agentWithOptions.timeout = options.timeout;
  }
}

/** Resolves the env proxy URL that should be used for a specific Node target. */
export function resolveEnvNodeProxyUrlForTarget(
  targetUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): URL | undefined {
  return resolveEnvNodeProxyTarget(targetUrl, env)?.proxyUrl;
}

function resolveEnvNodeProxyTarget(
  targetUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): { proxyUrl: URL; protocol: NodeProxyProtocol } | undefined {
  let target: URL;
  try {
    target = new URL(targetUrl instanceof URL ? targetUrl.href : targetUrl);
  } catch {
    return undefined;
  }
  // Normalize only this request's snapshot: WebSocket bypass uses HTTP(S)
  // default ports without mutating the caller's URL.
  if (target.protocol === "ws:") {
    target.protocol = "http:";
  } else if (target.protocol === "wss:") {
    target.protocol = "https:";
  }
  let protocol: NodeProxyProtocol;
  if (target.protocol === "http:") {
    protocol = "http";
  } else if (target.protocol === "https:") {
    protocol = "https";
  } else {
    return undefined;
  }
  if (matchesNoProxy(target, env)) {
    return undefined;
  }
  const proxyOptions = resolveEnvHttpProxyAgentOptions(env);
  const proxyUrl = protocol === "https" ? proxyOptions?.httpsProxy : proxyOptions?.httpProxy;
  return proxyUrl
    ? { proxyUrl: proxyUrlWithDefaultScheme(proxyUrl, protocol), protocol }
    : undefined;
}

function createFixedNodeProxyAgent(
  proxyUrl: string | URL,
  options: {
    protocol?: NodeProxyProtocol;
    proxyTls?: ProxylineTlsOptions;
    agentOptions?: NodeProxyAgentOptions;
    proxyConnect?: ProxylineProxyConnectOptions;
  } = {},
): ProxylineNodeAgent {
  const parsedProxyUrl =
    proxyUrl instanceof URL
      ? proxyUrl
      : proxyUrlWithDefaultScheme(proxyUrl, options.protocol ?? "https");
  const proxyConnect = options.proxyConnect;
  const agent = loadProxyline().createAmbientNodeProxyAgent({
    env: fixedProxyEnv(parsedProxyUrl),
    protocol: options.protocol ?? "https",
    ...(options.proxyTls !== undefined ? { proxyTls: options.proxyTls } : {}),
    ...(proxyConnect !== undefined ? { resolveProxyConnectOptions: () => proxyConnect } : {}),
  });
  if (agent === undefined) {
    throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${parsedProxyUrl.protocol}`);
  }
  applyNodeAgentOptions(agent, options.agentOptions);
  return agent;
}

function createPerRequestEnvProxyAgent(
  options: Extract<CreateNodeProxyAgentOptions, { mode: "env" }>,
): HttpsAgent | undefined {
  const env = { ...process.env };
  const proxies = resolveEnvHttpProxyAgentOptions(env);
  if (!proxies) {
    return undefined;
  }
  const routes = new Map<NodeProxyProtocol, ProxylineNodeAgent["addRequest"]>();
  const agents: ProxylineNodeAgent[] = [];
  for (const protocol of ["http", "https"] as const) {
    const value = protocol === "http" ? proxies.httpProxy : proxies.httpsProxy;
    if (!value) {
      continue;
    }
    try {
      const proxyUrl = proxyUrlWithDefaultScheme(value, protocol);
      const agent = createFixedNodeProxyAgent(proxyUrl, {
        protocol: options.protocol,
        proxyTls: resolveActiveManagedProxyTlsOptions({ proxyUrl: proxyUrl.href, env }),
        agentOptions: options.agentOptions,
        proxyConnect: options.proxyConnect,
      });
      routes.set(protocol, agent.addRequest.bind(agent));
      agents.push(agent);
    } catch (error) {
      // An invalid route must fail when selected, without disabling the other
      // protocol or turning a configured proxy request into a direct request.
      routes.set(protocol, () => {
        throw error;
      });
    }
  }
  const { ProxylineNodeProxyAgent } = loadProxyline();
  const router = new ProxylineNodeProxyAgent({
    ...options.agentOptions,
    defaultProtocol: options.protocol ?? "https",
    getProxyForUrl: () => "",
  });
  const directRequest = router.addRequest.bind(router);
  router.addRequest = (request, requestOptions) => {
    const protocol = request.protocol === "https:" ? "https" : "http";
    const host = isIPv6(request.host) ? `[${request.host}]` : request.host;
    const target = new URL(`${request.protocol}//${host}`);
    if (requestOptions.port) {
      target.port = String(requestOptions.port);
    }
    const route = matchesNoProxy(target, env) ? undefined : routes.get(protocol);
    if (route) {
      route(request, requestOptions);
    } else {
      directRequest(request, requestOptions);
    }
  };
  const destroyRouter = router.destroy.bind(router);
  router.destroy = () => {
    for (const agent of agents) {
      agent.destroy();
    }
    destroyRouter();
  };
  return router;
}

/** Creates a Node HTTP(S) agent for explicit proxy URLs; unsupported protocols throw. */
export function createNodeProxyAgent(
  options: Extract<CreateNodeProxyAgentOptions, { mode: "explicit" }>,
): HttpsAgent;
/** Creates a Node HTTP(S) agent from env proxy settings, or undefined when bypassed. */
export function createNodeProxyAgent(
  options: Extract<CreateNodeProxyAgentOptions, { mode: "env" }>,
): HttpsAgent | undefined;
export function createNodeProxyAgent(options: CreateNodeProxyAgentOptions): HttpsAgent | undefined {
  if (options.mode === "explicit") {
    return createFixedNodeProxyAgent(options.proxyUrl, {
      protocol: options.protocol,
      agentOptions: options.agentOptions,
      proxyConnect: options.proxyConnect,
    });
  }
  if (options.targetUrl === undefined) {
    return createPerRequestEnvProxyAgent(options);
  }
  const target = resolveEnvNodeProxyTarget(options.targetUrl);
  if (target === undefined) {
    return undefined;
  }
  return createFixedNodeProxyAgent(target.proxyUrl, {
    protocol: options.protocol ?? target.protocol,
    proxyTls: resolveActiveManagedProxyTlsOptions({ proxyUrl: target.proxyUrl.href }),
    agentOptions: options.agentOptions,
    proxyConnect: options.proxyConnect,
  });
}

/** Builds paired HTTP and HTTPS agents for libraries that require both slots. */
export function createFixedNodeProxyAgentPair(proxyUrl: string | URL): {
  httpAgent: HttpAgent;
  httpsAgent: HttpAgent;
} {
  const parsedProxyUrl =
    proxyUrl instanceof URL ? proxyUrl : proxyUrlWithDefaultScheme(proxyUrl, "https");
  const proxyTls = resolveActiveManagedProxyTlsOptions({ proxyUrl: parsedProxyUrl.href });
  return {
    httpAgent: createFixedNodeProxyAgent(parsedProxyUrl, { protocol: "http", proxyTls }),
    httpsAgent: createFixedNodeProxyAgent(parsedProxyUrl, { protocol: "https", proxyTls }),
  };
}
