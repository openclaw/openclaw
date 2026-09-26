import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import type { TlsOptions } from "node:tls";
import type {
  PortalOpenResult,
  PortalSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  isValidPortalIngressDomain,
  portalIngressConflictsWithOrigin,
} from "../../config/gateway-portal-ingress.js";
import type { GatewayPortalIngressConfig } from "../../config/types.gateway.js";
import { resolveAdvertisedLanHostCore } from "../../infra/advertised-lan-host.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import { claimTailscaleServePort, type TailscaleRouteClaim } from "../../infra/tailscale.js";
import { listenGatewayHttpServer } from "../server/http-listen.js";
import { getTailscalePublishedOrigin } from "../tailscale-published-origin.js";
import {
  handlePortalProxyRequest,
  handlePortalProxyUpgrade,
  type PortalTarget,
} from "./portal-http-proxy.js";
import { createPortalIngress, portalIngressHostname } from "./portal-ingress.js";
import { resolvePortalTlsHostname } from "./portal-tls-hostname.js";

const PORTAL_PORT_ALLOCATION_ATTEMPTS = 10;

type PortalEntry = {
  id: string;
  title: string;
  description?: string;
  path?: string;
  origin?: string;
  target: PortalTarget;
  resourceOwnerKey?: string;
  token: string;
  cookieNamespace: string;
  listenPort: number;
  createdAtMs: number;
  publicOrigin: string;
  partitionedCookies: boolean;
};

type PortalRuntimeEntry = {
  portal: PortalEntry;
  servers: HttpServer[];
  upgradedSockets: Set<Duplex>;
  onClose?: () => Promise<void> | void;
  claim?: TailscaleRouteClaim;
  detachOwner?: () => void;
  ingressSignal?: AbortSignal;
  revoked?: boolean;
  responses: Set<ServerResponse>;
};

type GatewayPortalOpenParams = {
  targetPort: number;
  target?: PortalTarget;
  /** Revalidated before metadata mutation or publication after asynchronous listener startup. */
  assertCurrent?: () => void;
  /** Resource lifetime, independent of the operation or actor that created the link. */
  ownerSignal?: AbortSignal;
  /** Internal resource identity; scoped resources must not adopt a global portal's lifetime. */
  resourceOwnerKey?: string;
  /** Ownership transfers to open; unused targets are released even when it rejects or reuses a portal. */
  onClose?: () => Promise<void> | void;
  origin?: string;
  title?: string;
  description?: string;
  path?: string;
};

export type GatewayPortalService = {
  open: (params: GatewayPortalOpenParams) => Promise<PortalOpenResult>;
  list: () => PortalSummary[];
  listWorkerPortals: (
    environmentId: string,
    ownerEpoch: number,
    resourceOwnerKey?: string,
  ) => PortalSummary[];
  close: (id: string, assertCurrent?: () => void) => Promise<void>;
  closeWorkerPortals: (environmentId: string, ownerEpoch?: number) => Promise<void>;
  closeAll: () => Promise<void>;
};

function removeServers(shared: HttpServer[], owned: readonly HttpServer[]): void {
  for (const server of owned) {
    const index = shared.indexOf(server);
    if (index >= 0) {
      shared.splice(index, 1);
    }
  }
}

async function closeServers(servers: readonly HttpServer[]): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
}

async function formatPortalHost(host: string): Promise<string> {
  // Wildcard listeners already accept LAN connections. Publish their actual LAN
  // address here rather than asking clients to reconstruct it from the Gateway URL.
  const lanHost =
    host === "0.0.0.0" || host === "::"
      ? await resolveAdvertisedLanHostCore().catch(() => null)
      : null;
  const openableHost = lanHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host);
  return openableHost.includes(":") ? `[${openableHost}]` : openableHost;
}

function createPortalProxyHandlers(
  resolveRuntime: (req: IncomingMessage) => PortalRuntimeEntry | undefined,
  tls: boolean,
) {
  return {
    request: (req: IncomingMessage, res: ServerResponse) => {
      const runtime = resolveRuntime(req);
      if (!runtime) {
        res.writeHead(404);
        res.end("Unknown portal");
        return;
      }
      runtime.responses.add(res);
      res.once("close", () => runtime.responses.delete(res));
      handlePortalProxyRequest({ req, res, target: runtime.portal, tls });
    },
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const runtime = resolveRuntime(req);
      if (!runtime) {
        socket.destroy();
        return;
      }
      handlePortalProxyUpgrade({
        req,
        socket,
        head,
        target: runtime.portal,
        upgradedSockets: runtime.upgradedSockets,
        tls,
      });
    },
  };
}

/** Creates the gateway-lifetime registry and per-portal transport listeners. */
export function createGatewayPortalService(params: {
  httpBindHosts: readonly string[];
  tlsOptions?: TlsOptions;
  httpServers: HttpServer[];
  ingress?: GatewayPortalIngressConfig;
  managedTailscale?: boolean;
  gatewayOrigins?: readonly string[];
}): GatewayPortalService & { startIngress: () => Promise<void> } {
  const entries = new Map<string, PortalRuntimeEntry>();
  const operations = new Map<string, Promise<void>>();
  let closed = false;
  const isAvailable = (runtime: PortalRuntimeEntry) =>
    !closed &&
    !runtime.revoked &&
    !runtime.ingressSignal?.aborted &&
    (!runtime.claim || runtime.claim.isActive());
  const ingressDomain = params.ingress?.domain.toLowerCase();
  if (
    ingressDomain &&
    (!isValidPortalIngressDomain(ingressDomain) ||
      params.gatewayOrigins?.some((origin) =>
        portalIngressConflictsWithOrigin(ingressDomain, origin),
      ))
  ) {
    throw new Error(
      "Portal ingress must use a valid separate DNS domain from the Gateway and Control UI",
    );
  }
  const lookupIngress = (host: string | undefined) => {
    const hostname = portalIngressHostname(host);
    if (!hostname || closed) {
      return undefined;
    }
    // The portal registry is the only routing authority; unknown and retired hosts have no target.
    for (const runtime of entries.values()) {
      if (isAvailable(runtime) && runtime.portal.publicOrigin === `https://${hostname}`) {
        return runtime;
      }
    }
    return undefined;
  };
  const ingress = params.ingress
    ? createPortalIngress({
        port: params.ingress.port,
        httpServers: params.httpServers,
        ...createPortalProxyHandlers((req) => lookupIngress(req.headers.host), true),
      })
    : undefined;

  const summarize = (portal: PortalEntry): PortalOpenResult => {
    const tokenQuery = `openclaw_portal=${portal.token}`;
    const publicUrl = `${portal.publicOrigin}${portal.path ?? "/"}`;
    const openableUrl = new URL(publicUrl);
    openableUrl.searchParams.set("openclaw_portal", portal.token);
    return {
      id: portal.id,
      title: portal.title,
      port: portal.target.kind === "local" ? portal.target.port : portal.target.remotePort,
      listenPort: portal.listenPort,
      tokenQuery,
      url: openableUrl.toString(),
      publicUrl,
      ...(portal.path ? { path: portal.path } : {}),
      ...(portal.description ? { description: portal.description } : {}),
      ...(portal.origin ? { origin: portal.origin } : {}),
      createdAtMs: portal.createdAtMs,
    };
  };

  const serialize = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const previous = operations.get(id) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    operations.set(id, completion);
    try {
      return await result;
    } finally {
      if (operations.get(id) === completion) {
        operations.delete(id);
      }
    }
  };

  const closeEntry = async (id: string): Promise<void> => {
    const runtime = entries.get(id);
    if (!runtime) {
      return;
    }
    // Remove authority before asynchronous teardown so no request can rediscover a closing portal.
    entries.delete(id);
    removeServers(params.httpServers, runtime.servers);
    for (const socket of runtime.upgradedSockets) {
      socket.destroy();
    }
    runtime.upgradedSockets.clear();
    for (const response of runtime.responses) {
      response.destroy();
    }
    runtime.responses.clear();
    runtime.detachOwner?.();
    // Release every owned resource even if a route owner reports a teardown error.
    const cleanup = await Promise.allSettled([
      closeServers(runtime.servers),
      Promise.resolve().then(() => runtime.claim?.stop()),
      Promise.resolve().then(() => runtime.onClose?.()),
    ]);
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  };

  const summarizeEntries = (selected: Iterable<PortalRuntimeEntry>): PortalSummary[] =>
    Array.from(selected)
      .filter(isAvailable)
      .map(({ portal }) => summarize(portal))
      .toSorted(
        (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
      );

  return {
    startIngress: async () => {
      await ingress?.start();
    },
    open: async (input) => {
      const target: PortalTarget = input.target ?? { kind: "local", port: input.targetPort };
      const targetPort = target.kind === "local" ? target.port : target.remotePort;
      const resourceOwnerSuffix =
        input.resourceOwnerKey === undefined
          ? ""
          : `-owner-${sha256HexPrefixCore(input.resourceOwnerKey, 32)}`;
      const id =
        target.kind === "local"
          ? `p${targetPort}`
          : `p${targetPort}${resourceOwnerSuffix}-worker-${sha256HexPrefixCore(target.environmentId, 32)}-${target.ownerEpoch}`;
      return await serialize(id, async () => {
        let releaseTarget = input.onClose;
        try {
          if (closed) {
            throw new Error("portals unavailable");
          }
          input.assertCurrent?.();
          input.ownerSignal?.throwIfAborted();
          let existing = entries.get(id);
          if (existing && !isAvailable(existing)) {
            await closeEntry(id);
            input.assertCurrent?.();
            input.ownerSignal?.throwIfAborted();
            if (closed) {
              throw new Error("portals unavailable");
            }
            existing = undefined;
          }
          if (existing) {
            existing.portal.title = input.title?.trim() || existing.portal.title;
            if (input.description !== undefined) {
              existing.portal.description = input.description;
            }
            if (input.path !== undefined) {
              existing.portal.path = input.path;
            }
            if (input.origin !== undefined) {
              existing.portal.origin = input.origin;
            }
            return summarize(existing.portal);
          }
          if (params.httpBindHosts.length === 0) {
            throw new Error("Gateway listener must start before opening a portal");
          }

          const managed =
            !ingress && params.managedTailscale ? getTailscalePublishedOrigin() : undefined;
          if (!ingress && params.managedTailscale && (!managed || managed.signal.aborted)) {
            throw new Error(
              "Private portal ingress unavailable: the managed Tailscale route is not active",
            );
          }
          const gatewayPublication = getTailscalePublishedOrigin();
          if (
            ingressDomain &&
            gatewayPublication &&
            portalIngressConflictsWithOrigin(ingressDomain, gatewayPublication.origin)
          ) {
            throw new Error("Portal ingress domain conflicts with the managed Gateway hostname");
          }
          const bindHosts = managed ? ["127.0.0.1"] : params.httpBindHosts;
          const tlsOptions = managed ? undefined : params.tlsOptions;
          const portal: PortalEntry = {
            id,
            ...(input.resourceOwnerKey !== undefined
              ? { resourceOwnerKey: input.resourceOwnerKey }
              : {}),
            title: input.title?.trim() || `Port ${targetPort}`,
            ...(input.description ? { description: input.description } : {}),
            ...(input.path ? { path: input.path } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
            target,
            token: randomBytes(32).toString("hex"),
            cookieNamespace: randomBytes(16).toString("hex"),
            listenPort: 0,
            createdAtMs: Date.now(),
            publicOrigin: "",
            // Every HTTPS portal can be embedded from another site, not only wildcard ingress.
            partitionedCookies: Boolean(ingress || managed || tlsOptions),
          };
          const upgradedSockets = new Set<Duplex>();
          const responses = new Set<ServerResponse>();
          const { request, upgrade } = createPortalProxyHandlers(
            () => {
              const runtime = entries.get(id);
              return runtime?.portal === portal && isAvailable(runtime) ? runtime : undefined;
            },
            Boolean(managed || tlsOptions),
          );
          const servers = ingress
            ? []
            : bindHosts.map(() =>
                tlsOptions ? createHttpsServer(tlsOptions, request) : createHttpServer(request),
              );
          for (const server of servers) {
            server.on("upgrade", upgrade);
          }
          // Registration precedes every bind so whole-gateway cleanup owns partial startup.
          params.httpServers.push(...servers);
          let claim: TailscaleRouteClaim | undefined;
          try {
            if (ingress) {
              portal.listenPort = await ingress.start();
              if (target.kind === "local" && portal.listenPort === targetPort) {
                throw new Error("Portal target port must differ from the portal ingress listener");
              }
              portal.publicOrigin = `https://${randomBytes(16).toString("hex")}.${ingressDomain}`;
            } else {
              const primaryServer = servers[0];
              const primaryHost = bindHosts[0];
              if (!primaryServer || !primaryHost) {
                throw new Error("Missing primary portal HTTP server");
              }
              for (let attempt = 0; attempt < PORTAL_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
                await listenGatewayHttpServer({
                  httpServer: primaryServer,
                  bindHost: primaryHost,
                  port: 0,
                  retryEaddrinuse: false,
                  serviceName: "portal",
                  endpointScheme: tlsOptions ? "https" : "http",
                });
                const address = primaryServer.address();
                if (!address || typeof address === "string") {
                  throw new Error("Portal listener failed to resolve its port");
                }
                if (target.kind === "worker" || address.port !== targetPort) {
                  portal.listenPort = address.port;
                  break;
                }
                // A proxy cannot share its target port: it would dial itself and fail auth.
                await closeServers([primaryServer]);
              }
              if (portal.listenPort === 0) {
                throw new Error(`Portal listener repeatedly allocated target port ${targetPort}`);
              }
              for (const [index, host] of bindHosts.entries()) {
                if (index === 0) {
                  continue;
                }
                const server = servers[index];
                if (!server) {
                  throw new Error(`Missing portal HTTP server for bind host ${host}`);
                }
                await listenGatewayHttpServer({
                  httpServer: server,
                  bindHost: host,
                  port: portal.listenPort,
                  retryEaddrinuse: false,
                  serviceName: "portal",
                  endpointScheme: tlsOptions ? "https" : "http",
                });
              }
              if (managed) {
                // The backend ephemeral port selects a distinct external HTTPS port; Tailscale
                // atomically rejects occupied routes rather than adopting or replacing them.
                const httpsPort = portal.listenPort;
                const gatewayUrl = new URL(managed.origin);
                if (httpsPort === Number(gatewayUrl.port || 443)) {
                  throw new Error("Portal HTTPS port conflicts with the Gateway origin");
                }
                const assertServeCurrent = () => {
                  input.assertCurrent?.();
                  if (closed || managed.signal.aborted) {
                    throw new Error("Private portal ingress closed during startup");
                  }
                };
                assertServeCurrent();
                claim = await claimTailscaleServePort(
                  portal.listenPort,
                  httpsPort,
                  assertServeCurrent,
                );
                if (!claim.isActive() || managed.signal.aborted) {
                  throw new Error("Private portal ingress lost during startup");
                }
                gatewayUrl.port = String(httpsPort);
                if (params.gatewayOrigins?.includes(gatewayUrl.origin)) {
                  throw new Error("Portal HTTPS origin conflicts with the Control UI");
                }
                portal.publicOrigin = gatewayUrl.origin;
              } else {
                const bindHostname = await formatPortalHost(primaryHost);
                const hostname = tlsOptions
                  ? resolvePortalTlsHostname(tlsOptions, params.gatewayOrigins ?? [], bindHostname)
                  : bindHostname;
                portal.publicOrigin = `${tlsOptions ? "https" : "http"}://${hostname}:${portal.listenPort}`;
              }
            }
            if (closed) {
              throw new Error("portals unavailable");
            }
            // A queued successor must not discover a portal created by a now-revoked turn.
            input.assertCurrent?.();
            input.ownerSignal?.throwIfAborted();
            if (managed && (managed.signal.aborted || !claim?.isActive())) {
              throw new Error("Private portal ingress lost before publication");
            }
          } catch (error) {
            removeServers(params.httpServers, servers);
            for (const socket of upgradedSockets) {
              socket.destroy();
            }
            await Promise.all([closeServers(servers), claim?.stop()]);
            throw error;
          }
          const runtime: PortalRuntimeEntry = {
            portal,
            servers,
            upgradedSockets,
            ...(input.onClose ? { onClose: input.onClose } : {}),
            claim,
            responses,
            ingressSignal: managed?.signal,
          };
          entries.set(id, runtime);
          const ownerSignals = [input.ownerSignal, managed?.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          );
          if (claim || ownerSignals.length) {
            const retire = () => {
              // Capture this exact lifetime: an old claim must never close a reopened portal.
              if (entries.get(id) === runtime) {
                runtime.revoked = true;
                void serialize(id, async () => {
                  if (entries.get(id) === runtime) {
                    await closeEntry(id);
                  }
                }).catch(() => undefined);
              }
            };
            for (const signal of ownerSignals) {
              signal.addEventListener("abort", retire, { once: true });
            }
            runtime.detachOwner = () => {
              for (const signal of ownerSignals) {
                signal.removeEventListener("abort", retire);
              }
            };
            if (claim) {
              void claim.exited.then(retire, retire);
            }
          }
          releaseTarget = undefined;
          return summarize(portal);
        } finally {
          await releaseTarget?.();
        }
      });
    },
    list: () => summarizeEntries(entries.values()),
    listWorkerPortals: (environmentId, ownerEpoch, resourceOwnerKey) =>
      summarizeEntries(
        [...entries.values()].filter(
          ({ portal }) =>
            portal.target.kind === "worker" &&
            portal.target.environmentId === environmentId &&
            portal.target.ownerEpoch === ownerEpoch &&
            (resourceOwnerKey === undefined || portal.resourceOwnerKey === resourceOwnerKey),
        ),
      ),
    close: async (id, assertCurrent) => {
      await serialize(id, () => {
        assertCurrent?.();
        return closeEntry(id);
      });
    },
    closeWorkerPortals: async (environmentId, ownerEpoch) => {
      const environmentSuffix = `-worker-${sha256HexPrefixCore(environmentId, 32)}-`;
      // Include in-flight opens so teardown fences a listener still awaiting its bind.
      const ids = [...new Set([...entries.keys(), ...operations.keys()])].filter((id) => {
        const separator = id.indexOf(environmentSuffix);
        return (
          separator >= 0 &&
          (ownerEpoch === undefined ||
            id.slice(separator + environmentSuffix.length) === String(ownerEpoch))
        );
      });
      await Promise.all(ids.map((id) => serialize(id, () => closeEntry(id))));
    },
    closeAll: async () => {
      closed = true;
      const ids = new Set([...entries.keys(), ...operations.keys()]);
      try {
        await Promise.all([...ids].map((id) => serialize(id, () => closeEntry(id))));
      } finally {
        await ingress?.close();
      }
    },
  };
}
