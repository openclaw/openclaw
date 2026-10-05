import { execFileSync } from "node:child_process";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { NodeRegistry } from "./node-registry.js";
import { PLUGIN_NODE_CAPABILITY_PATH_PREFIX } from "./plugin-node-capability.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";
import { withTempConfig } from "./test-temp-config.js";

/* Route-level proof that capability authorization precedes HTTP and WebSocket dispatch. */
const HTTP_TIMEOUT_MS = 15_000;
const WS_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;
const CANVAS_PATH = "/__openclaw__/canvas";
const CANVAS_WS_PATH = `${CANVAS_PATH}/test/ws`;
const CAPABILITY_PATH_PREFIX = PLUGIN_NODE_CAPABILITY_PATH_PREFIX;
const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  password: undefined,
  allowTailscale: false,
};

type DispatchCounts = { http: number; ws: number };
type BoundaryResult = {
  http?: number;
  ws?: number;
  responseComplete?: boolean;
  dispatches: DispatchCounts;
};
type GatewayTestHttpServer = Awaited<
  ReturnType<typeof createGatewayRuntimeStateForTest>
>["httpServer"];

function scheduleCapabilityRevocationAfterAuthorization(params: {
  client: GatewayWsClient;
  nodeRegistry: NodeRegistry;
  nodeId: string;
  revokeOnRead?: number;
}): Promise<void> {
  let liveCaps = ["canvas"];
  let authorizationReads = 0;
  const revokeOnRead = params.revokeOnRead ?? 2;
  let resolveRevocation!: () => void;
  let rejectRevocation!: (error: unknown) => void;
  const revocation = new Promise<void>((resolve, reject) => {
    resolveRevocation = resolve;
    rejectRevocation = reject;
  });
  Object.defineProperty(params.client.connect, "caps", {
    configurable: true,
    get: () => {
      authorizationReads += 1;
      // Return the current snapshot for this authorization, then revoke the
      // registry so a following check observes that the node lost approval.
      const currentCaps = liveCaps;
      if (authorizationReads === revokeOnRead) {
        try {
          const revoked = params.nodeRegistry.updateSurface(params.nodeId, {
            caps: [],
            commands: [],
          });
          if (!revoked || revoked.caps.length !== 0) {
            throw new Error(`failed to revoke proof node ${params.nodeId}`);
          }
          resolveRevocation();
        } catch (error) {
          rejectRevocation(error);
        }
      }
      return currentCaps;
    },
    set: (nextCaps: string[]) => {
      liveCaps = nextCaps;
    },
  });
  return revocation;
}

function makeWsClient(params: {
  connId: string;
  clientIp: string;
  role: "node" | "operator";
  capability: string;
  caps?: string[];
  capabilityStorageKey?: string;
}): GatewayWsClient {
  return {
    socket: {} as unknown as WebSocket,
    connect: {
      role: params.role,
      caps: params.caps ?? (params.role === "node" ? ["canvas"] : []),
      client: { id: params.connId, mode: params.role === "node" ? "node" : "webchat" },
      ...(params.role === "node" ? { declaredCaps: ["canvas"] } : {}),
    } as GatewayWsClient["connect"],
    connId: params.connId,
    usesSharedGatewayAuth: false,
    clientIp: params.clientIp,
    pluginNodeCapabilities: {
      [params.capabilityStorageKey ?? "canvas"]: {
        capability: params.capability,
        expiresAtMs: Date.now() + 60_000,
      },
    },
  };
}

function scopedPath(capability: string, path: string): string {
  return `${CAPABILITY_PATH_PREFIX}/${encodeURIComponent(capability)}${path}`;
}

async function fetchCanvas(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { connection: "close" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function requestWsStatus(port: number, path: string): Promise<number> {
  return (await requestWsResponse(port, path)).statusCode;
}

async function requestWsResponse(
  port: number,
  path: string,
): Promise<{ statusCode: number; complete: boolean }> {
  return await new Promise<{ statusCode: number; complete: boolean }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    req.setTimeout(WS_TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve({ statusCode: res.statusCode ?? 0, complete: res.complete }));
      res.once("aborted", () => reject(new Error("incomplete websocket rejection response")));
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected capability rejection"));
    });
    req.once("error", reject);
    req.end();
  });
}

function delayNextSocketEnd(server: GatewayTestHttpServer) {
  let armed = false;
  let deferredEndArgs: unknown[] | undefined;
  let resolveEndQueued: (() => void) | undefined;
  let releaseQueuedEnd: (() => void) | undefined;
  let wasDestroyedBeforeRelease = false;
  let released = false;

  server.prependListener("connection", (socket) => {
    if (!armed) {
      return;
    }
    armed = false;
    const originalEnd = socket.end.bind(socket);
    const originalDestroy = socket.destroy.bind(socket);
    Object.defineProperty(socket, "end", {
      configurable: true,
      value: (...args: unknown[]) => {
        deferredEndArgs = args;
        resolveEndQueued?.();
        return socket;
      },
    });
    Object.defineProperty(socket, "destroy", {
      configurable: true,
      value: (...args: unknown[]) => {
        if (deferredEndArgs && !released) {
          wasDestroyedBeforeRelease = true;
        }
        return Reflect.apply(originalDestroy, socket, args);
      },
    });
    releaseQueuedEnd = () => {
      if (!deferredEndArgs) {
        throw new Error("no deferred socket end to release");
      }
      released = true;
      Reflect.apply(originalEnd, socket, deferredEndArgs);
    };
  });

  return {
    waitForEndQueued() {
      armed = true;
      return new Promise<void>((resolve) => {
        resolveEndQueued = resolve;
      });
    },
    release() {
      if (!releaseQueuedEnd) {
        throw new Error("socket connection was not intercepted");
      }
      releaseQueuedEnd();
    },
    get wasDestroyedBeforeRelease() {
      return wasDestroyedBeforeRelease;
    },
  };
}

async function expectWsStatus(port: number, path: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("websocket connection timed out"));
    }, WS_TIMEOUT_MS);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      resolve(101);
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`unexpected response ${res.statusCode}`));
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function runBoundaryProof(
  run: (
    port: number,
    clients: Set<GatewayWsClient>,
    getDispatches: () => DispatchCounts,
    httpServer: GatewayTestHttpServer,
  ) => Promise<void>,
) {
  let httpDispatches = 0;
  let wsDispatches = 0;
  const canvasWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
  const handleCanvasHttp = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== CANVAS_PATH && !pathname.startsWith(`${CANVAS_PATH}/`)) {
      return false;
    }
    httpDispatches += 1;
    res.statusCode = 200;
    res.end("ok");
    return true;
  };
  const handleCanvasUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== CANVAS_WS_PATH) {
      return false;
    }
    wsDispatches += 1;
    canvasWss.handleUpgrade(req, socket, head, (ws) => ws.close());
    return true;
  };
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path: CANVAS_PATH,
    auth: "plugin",
    match: "prefix",
    handler: handleCanvasHttp,
    handleUpgrade: handleCanvasUpgrade,
    pluginId: "canvas-plugin",
    source: "test",
    nodeCapability: { surface: "canvas" },
  });
  const runtime = await createGatewayRuntimeStateForTest(registry, {
    cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
    resolvedAuth,
    getResolvedAuth: () => resolvedAuth,
  });
  await runtime.startListening();
  const address = runtime.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("expected proof gateway TCP address");
  }
  const clients = runtime.clients;
  try {
    await run(
      address.port,
      clients,
      () => ({ http: httpDispatches, ws: wsDispatches }),
      runtime.httpServer,
    );
  } finally {
    for (const ws of canvasWss.clients) {
      ws.terminate();
    }
    for (const ws of runtime.wss.clients) {
      ws.terminate();
    }
    await withTimeout(
      new Promise<void>((resolve) => {
        canvasWss.close(() => resolve());
      }),
      CLOSE_TIMEOUT_MS,
      { message: "proof canvas websocket server close timed out" },
    );
    await withTimeout(
      new Promise<void>((resolve) => {
        runtime.wss.close(() => resolve());
      }),
      CLOSE_TIMEOUT_MS,
      { message: "proof gateway websocket server close timed out" },
    );
    await Promise.all(
      runtime.httpServers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  }
}

describe("gateway plugin node capability boundary proof", () => {
  test("rejects pending, revoked, and concurrently revoked nodes before dispatch", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: ["127.0.0.1"] } },
      run: async () => {
        const proof: Record<string, BoundaryResult> = {};
        await runBoundaryProof(async (port, clients, dispatches, httpServer) => {
          const probeHttp = async (capability: string) =>
            await fetchCanvas(
              `http://127.0.0.1:${port}${scopedPath(capability, `${CANVAS_PATH}/`)}`,
            );
          const pendingCapability = "pending-node";
          const pendingNode = makeWsClient({
            connId: "c-pending-node",
            clientIp: "192.168.1.10",
            role: "node",
            capability: pendingCapability,
            caps: [],
            capabilityStorageKey: "canvas\u0000canvas-plugin:canvas",
          });
          const nodeRegistry = new NodeRegistry();
          try {
            nodeRegistry.register(pendingNode, { pairingIdentity: "pending-node" });
            clients.add(pendingNode);
            const pendingHttp = await probeHttp(pendingCapability);
            const pendingWs = await requestWsStatus(
              port,
              scopedPath(pendingCapability, CANVAS_WS_PATH),
            );
            expect(pendingHttp.status).toBe(401);
            expect(pendingWs).toBe(401);
            expect(dispatches()).toEqual({ http: 0, ws: 0 });
            proof.pending = { http: pendingHttp.status, ws: pendingWs, dispatches: dispatches() };

            // Keep these first-use probes before the positive requests so each
            // transport exercises server-runtime-state's lazy plugin owner.
            const raceHttpCapability = "race-http-node";
            const raceHttpNode = makeWsClient({
              connId: "c-race-http-node",
              clientIp: "192.168.1.20",
              role: "node",
              capability: raceHttpCapability,
              capabilityStorageKey: "canvas\u0000canvas-plugin:canvas",
            });
            const raceHttpNodeRegistry = new NodeRegistry();
            raceHttpNodeRegistry.register(raceHttpNode, { pairingIdentity: "race-http-node" });
            clients.add(raceHttpNode);
            try {
              const revocation = scheduleCapabilityRevocationAfterAuthorization({
                client: raceHttpNode,
                nodeRegistry: raceHttpNodeRegistry,
                nodeId: "c-race-http-node",
              });
              const raceHttp = await probeHttp(raceHttpCapability);
              await revocation;
              expect(raceHttp.status).toBe(401);
              expect(dispatches()).toEqual({ http: 0, ws: 0 });
              proof.raceHttp = {
                http: raceHttp.status,
                dispatches: dispatches(),
              };
            } finally {
              clients.delete(raceHttpNode);
              raceHttpNodeRegistry.unregister(raceHttpNode.connId);
            }

            const raceWsCapability = "race-ws-node";
            const raceWsNode = makeWsClient({
              connId: "c-race-ws-node",
              clientIp: "192.168.1.21",
              role: "node",
              capability: raceWsCapability,
              capabilityStorageKey: "canvas\u0000canvas-plugin:canvas",
            });
            const raceWsNodeRegistry = new NodeRegistry();
            raceWsNodeRegistry.register(raceWsNode, { pairingIdentity: "race-ws-node" });
            clients.add(raceWsNode);
            try {
              const revocation = scheduleCapabilityRevocationAfterAuthorization({
                client: raceWsNode,
                nodeRegistry: raceWsNodeRegistry,
                nodeId: "c-race-ws-node",
                revokeOnRead: 1,
              });
              const delayedFlush = delayNextSocketEnd(httpServer);
              const flushQueued = delayedFlush.waitForEndQueued();
              const raceWsResponse = requestWsResponse(
                port,
                scopedPath(raceWsCapability, CANVAS_WS_PATH),
              );
              raceWsResponse.catch(() => undefined);
              await withTimeout(flushQueued, WS_TIMEOUT_MS, {
                message: "race WebSocket rejection response was not queued",
              });
              await revocation;
              expect(delayedFlush.wasDestroyedBeforeRelease).toBe(false);
              delayedFlush.release();
              const raceWs = await raceWsResponse;
              expect(raceWs.statusCode).toBe(401);
              expect(raceWs.complete).toBe(true);
              expect(dispatches()).toEqual({ http: 0, ws: 0 });
              proof.raceWs = {
                ws: raceWs.statusCode,
                responseComplete: raceWs.complete,
                dispatches: dispatches(),
              };
            } finally {
              clients.delete(raceWsNode);
              raceWsNodeRegistry.unregister(raceWsNode.connId);
            }

            const approved = nodeRegistry.updateSurface("c-pending-node", {
              caps: ["canvas"],
              commands: [],
            });
            expect(approved?.caps).toEqual(["canvas"]);
            const approvedHttp = await probeHttp(pendingCapability);
            const approvedWs = await expectWsStatus(
              port,
              scopedPath(pendingCapability, CANVAS_WS_PATH),
            );
            expect(approvedHttp.status).toBe(200);
            expect(approvedWs).toBe(101);
            expect(dispatches()).toEqual({ http: 1, ws: 1 });
            proof.approved = {
              http: approvedHttp.status,
              ws: approvedWs,
              dispatches: dispatches(),
            };

            const revoked = nodeRegistry.updateSurface("c-pending-node", {
              caps: [],
              commands: [],
            });
            expect(revoked?.caps).toEqual([]);
            const revokedHttp = await probeHttp(pendingCapability);
            const revokedWs = await requestWsStatus(
              port,
              scopedPath(pendingCapability, CANVAS_WS_PATH),
            );
            expect(revokedHttp.status).toBe(401);
            expect(revokedWs).toBe(401);
            expect(dispatches()).toEqual({ http: 1, ws: 1 });
            proof.revoked = { http: revokedHttp.status, ws: revokedWs, dispatches: dispatches() };
          } finally {
            clients.delete(pendingNode);
            nodeRegistry.unregister(pendingNode.connId);
          }

          const operatorCapability = "operator-cap";
          clients.add(
            makeWsClient({
              connId: "c-operator",
              clientIp: "192.168.1.15",
              role: "operator",
              capability: operatorCapability,
              capabilityStorageKey: "canvas\u0000canvas-plugin:canvas",
            }),
          );
          const operatorHttp = await probeHttp(operatorCapability);
          const operatorWs = await expectWsStatus(
            port,
            scopedPath(operatorCapability, CANVAS_WS_PATH),
          );
          expect(operatorHttp.status).toBe(200);
          expect(operatorWs).toBe(101);
          expect(dispatches()).toEqual({ http: 2, ws: 2 });
          proof.operator = { http: operatorHttp.status, ws: operatorWs, dispatches: dispatches() };
        });
        const testedCheckoutHead = execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        const mergeParents = execFileSync("git", ["cat-file", "-p", testedCheckoutHead], {
          encoding: "utf8",
        })
          .match(/^parent ([a-f0-9]{40})$/gmu)
          ?.map((line) => line.slice("parent ".length));
        const reviewedHead =
          process.env.RATCHET_PR_HEAD_SHA?.trim() || mergeParents?.[1] || testedCheckoutHead;
        expect(reviewedHead).toMatch(/^[a-f0-9]{40}$/u);
        if (mergeParents?.length === 2) {
          expect(mergeParents?.[1]).toBe(reviewedHead);
        }
        process.stdout.write(
          `plugin-node-capability-proof ${JSON.stringify(
            {
              reviewedHead,
              testedCheckoutHead,
              boundary: "Gateway Canvas plugin route authorization before HTTP/WS dispatch",
              ...proof,
            },
            null,
            2,
          )}\n`,
        );
      },
    });
  }, 60_000);
});
