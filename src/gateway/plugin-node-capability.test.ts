import { execFileSync } from "node:child_process";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { NodeRegistry } from "./node-registry.js";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  hasAuthorizedClientPluginNodeCapabilityUrl,
  hasAuthorizedPluginNodeCapability,
  indexPluginNodeCapabilitySurfaces,
  normalizePluginNodeCapabilityScopedUrl,
  pluginNodeCapabilityScopedHostUrlsConflict,
  prepareClientPluginNodeCapabilities,
  reconcileClientPluginNodeCapabilities,
  refreshClientPluginNodeCapability,
  setClientPluginNodeCapability,
  PLUGIN_NODE_CAPABILITY_PATH_PREFIX,
} from "./plugin-node-capability.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";
import { withTempConfig } from "./test-temp-config.js";

function makeClient(
  overrides: Partial<GatewayWsClient> & {
    pluginNodeCapabilities?: GatewayWsClient["pluginNodeCapabilities"];
  } = {},
  caps: string[] = ["canvas"],
): GatewayWsClient {
  return {
    socket: {} as GatewayWsClient["socket"],
    connect: {
      role: "node",
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      caps,
      client: {
        mode: "node",
      },
    } as GatewayWsClient["connect"],
    connId: "node-1",
    usesSharedGatewayAuth: false,
    ...overrides,
  };
}

describe("plugin node capability helpers", () => {
  test("publishes plugin surface replacement atomically while retaining unaffected credentials", () => {
    const canvas = { surface: "canvas", scopeKey: "drawing:canvas" };
    const files = { surface: "files", scopeKey: "storage:files" };
    const removed = { surface: "retired", scopeKey: "drawing:retired" };
    const client = makeClient({ pluginSurfaceBaseUrl: "https://gateway.example" });
    prepareClientPluginNodeCapabilities({
      client,
      surfaces: [canvas, files, removed],
      changedPluginIds: new Set(),
    })();
    const previous = { ...client.pluginSurfaceUrls };
    const publish = prepareClientPluginNodeCapabilities({
      client,
      surfaces: [canvas, files],
      changedPluginIds: new Set(["drawing"]),
    });
    expect(client.pluginSurfaceUrls).toEqual(previous);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        client,
        surface: canvas,
        url: previous.canvas!,
      }),
    ).toBe(true);
    publish();
    expect(client.pluginSurfaceUrls?.files).toBe(previous.files);
    expect(client.pluginSurfaceUrls?.retired).toBeUndefined();
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        client,
        surface: canvas,
        url: previous.canvas!,
      }),
    ).toBe(false);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        client,
        surface: removed,
        url: previous.retired!,
      }),
    ).toBe(false);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        client,
        surface: canvas,
        url: client.pluginSurfaceUrls!.canvas!,
      }),
    ).toBe(true);
  });

  test("publishes newly enabled surfaces only within the client's admitted capabilities", () => {
    const canvas = { surface: "canvas", scopeKey: "drawing:canvas" };
    const files = { surface: "files", scopeKey: "storage:files" };
    const client = makeClient({ pluginSurfaceBaseUrl: "https://gateway.example" });
    const publish = prepareClientPluginNodeCapabilities({
      client,
      surfaces: [canvas, files],
      changedPluginIds: new Set(["drawing", "storage"]),
      allowedSurfaces: new Set(["canvas"]),
    });
    expect(client.pluginSurfaceUrls).toBeUndefined();
    expect(client.pluginNodeCapabilities).toBeUndefined();
    publish();
    expect(Object.keys(client.pluginSurfaceUrls ?? {})).toEqual(["canvas"]);
    expect(client.pluginNodeCapabilitySurfaces).toEqual({ canvas });
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        client,
        surface: canvas,
        url: client.pluginSurfaceUrls!.canvas!,
      }),
    ).toBe(true);
    expect(Object.keys(client.pluginNodeCapabilities ?? {})).toEqual(["canvas\0drawing:canvas"]);
  });

  test("builds scoped host urls from clean base urls", () => {
    expect(
      buildPluginNodeCapabilityScopedHostUrl(
        "http://127.0.0.1:18789/root/?debug=1#hash",
        "token value",
      ),
    ).toBe("http://127.0.0.1:18789/root/__openclaw__/cap/token%20value");
    expect(buildPluginNodeCapabilityScopedHostUrl("not a url", "token")).toBeUndefined();
    expect(buildPluginNodeCapabilityScopedHostUrl("http://127.0.0.1:18789", " ")).toBeUndefined();
  });

  test("normalizes scoped urls and moves capability into the query string", () => {
    const normalized = normalizePluginNodeCapabilityScopedUrl(
      "/__openclaw__/cap/token%20value/__openclaw__/canvas/file.txt?download=1",
    );
    expect(normalized).toEqual({
      pathname: "/__openclaw__/canvas/file.txt",
      capability: "token value",
      rewrittenUrl: "/__openclaw__/canvas/file.txt?download=1&oc_cap=token+value",
      scopedPath: true,
      malformedScopedPath: false,
    });
  });

  test("detects conflicting scoped host capabilities across rewritten hosts", () => {
    expect(
      pluginNodeCapabilityScopedHostUrlsConflict(
        "http://127.0.0.1:18789/__openclaw__/cap/token%20value",
        "https://gateway.example:7443/__openclaw__/cap/token%20value",
      ),
    ).toBe(false);
    expect(
      pluginNodeCapabilityScopedHostUrlsConflict(
        "https://gateway.example/__openclaw__/cap/old-token",
        "https://gateway.example/__openclaw__/cap/new-token",
      ),
    ).toBe(true);
    expect(pluginNodeCapabilityScopedHostUrlsConflict("not-a-url", "also-not-a-url")).toBe(false);
  });

  test("validates a current scoped URL without extending its authorization", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "current-token", expiresAtMs: 1_500 },
      },
    });
    const params = {
      client,
      surface: { surface: "canvas" },
      url: "https://gateway.example/__openclaw__/cap/current-token",
      nowMs: 1_000,
    };

    expect(hasAuthorizedClientPluginNodeCapabilityUrl(params)).toBe(true);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_500);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        ...params,
        url: "https://gateway.example/__openclaw__/cap/other-token",
      }),
    ).toBe(false);
    expect(hasAuthorizedClientPluginNodeCapabilityUrl({ ...params, nowMs: 1_500 })).toBe(false);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        ...params,
        client: makeClient(),
      }),
    ).toBe(false);
    expect(
      hasAuthorizedClientPluginNodeCapabilityUrl({
        ...params,
        surface: { surface: "canvas", scopeKey: "other-plugin:canvas" },
      }),
    ).toBe(false);
  });

  test("treats the scoped path capability as authoritative over a stale query", () => {
    const normalized = normalizePluginNodeCapabilityScopedUrl(
      "/__openclaw__/cap/current-token/__openclaw__/canvas/?oc_cap=stale-token",
    );
    expect(normalized).toEqual({
      pathname: "/__openclaw__/canvas/",
      capability: "current-token",
      rewrittenUrl: "/__openclaw__/canvas/?oc_cap=current-token",
      scopedPath: true,
      malformedScopedPath: false,
    });
  });

  test("marks malformed scoped urls without authorizing a path capability", () => {
    const normalized = normalizePluginNodeCapabilityScopedUrl("/__openclaw__/cap/broken");
    expect(normalized.scopedPath).toBe(true);
    expect(normalized.malformedScopedPath).toBe(true);
    expect(normalized.capability).toBeUndefined();
    expect(normalized.rewrittenUrl).toBeUndefined();
  });

  test("marks malformed request targets without throwing", () => {
    for (const rawUrl of ["//", "///", "//${jndi:ldap://example}.action"]) {
      const normalized = normalizePluginNodeCapabilityScopedUrl(rawUrl);
      expect(normalized).toMatchObject({
        pathname: "/",
        scopedPath: false,
        malformedScopedPath: true,
      });
      expect(normalized.capability).toBeUndefined();
      expect(normalized.rewrittenUrl).toBeUndefined();
    }
  });

  test("stores capabilities per plugin surface", () => {
    const client = makeClient();
    setClientPluginNodeCapability({
      client,
      surface: { surface: "canvas" },
      capability: "canvas-token",
      expiresAtMs: 100,
    });
    setClientPluginNodeCapability({
      client,
      surface: { surface: "files" },
      capability: "files-token",
      expiresAtMs: 200,
    });
    expect(client.pluginNodeCapabilities).toEqual({
      canvas: { capability: "canvas-token", expiresAtMs: 100 },
      files: { capability: "files-token", expiresAtMs: 200 },
    });
  });

  test("stores capabilities per plugin-owned surface scope", () => {
    const client = makeClient();
    setClientPluginNodeCapability({
      client,
      surface: { surface: "canvas", scopeKey: "canvas-plugin:canvas" },
      capability: "canvas-token",
      expiresAtMs: 100,
    });
    setClientPluginNodeCapability({
      client,
      surface: { surface: "canvas", scopeKey: "other-plugin:canvas" },
      capability: "other-token",
      expiresAtMs: 200,
    });

    expect(client.pluginNodeCapabilities).toEqual({
      "canvas\u0000canvas-plugin:canvas": { capability: "canvas-token", expiresAtMs: 100 },
      "canvas\u0000other-plugin:canvas": { capability: "other-token", expiresAtMs: 200 },
    });
  });

  test("indexes plugin capability surfaces with shortest ttl per surface", () => {
    expect(
      indexPluginNodeCapabilitySurfaces([
        { surface: "canvas", ttlMs: 5_000 },
        { surface: " canvas ", ttlMs: 100 },
        { surface: "files" },
      ]),
    ).toEqual({
      canvas: { surface: "canvas", ttlMs: 100 },
      files: { surface: "files" },
    });
  });

  test.each([
    { change: "enabled", before: [], after: [{ surface: "files" }] },
    { change: "disabled", before: [{ surface: "files" }], after: [] },
    {
      change: "owner changed",
      before: [{ surface: "files", scopeKey: "previous:files" }],
      after: [{ surface: "files", scopeKey: "current:files" }],
    },
  ])("reconnects nodes when a capability is $change", ({ before, after }) => {
    const close = vi.fn();
    const client = makeClient({
      connect: { ...makeClient().connect, caps: ["files"] },
      pluginNodeCapabilitySurfaces: indexPluginNodeCapabilitySurfaces(before),
    });

    expect(
      reconcileClientPluginNodeCapabilities(
        client,
        indexPluginNodeCapabilitySurfaces(after),
        close,
      ),
    ).toBe(false);
    expect(client).toMatchObject({
      invalidated: true,
      invalidatedReason: "plugin-node-capabilities-changed",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(client.pluginSurfaceUrls).toBeUndefined();
  });

  test.each([
    { node: "browser-only", caps: ["browser"], maxProtocol: PROTOCOL_VERSION },
    { node: "without approved capabilities", caps: [], maxProtocol: PROTOCOL_VERSION },
  ])("preserves $node nodes across unrelated hosted-surface changes", ({ caps, maxProtocol }) => {
    const close = vi.fn();
    const client = makeClient({
      connect: { ...makeClient().connect, minProtocol: maxProtocol, maxProtocol, caps },
    });
    for (const next of [
      [{ surface: "files", scopeKey: "previous:files", ttlMs: 100 }],
      [{ surface: "files", scopeKey: "current:files", ttlMs: 200 }],
      [],
    ]) {
      const surfaces = indexPluginNodeCapabilitySurfaces(next);
      expect(reconcileClientPluginNodeCapabilities(client, surfaces, close)).toBe(true);
      expect(client.invalidated).toBeUndefined();
      expect(close).not.toHaveBeenCalled();
      expect(
        refreshClientPluginNodeCapability({ client, surface: { surface: "files" } }),
      ).toBeUndefined();
      client.pluginNodeCapabilitySurfaces = surfaces;
    }
  });

  test("reconnects legacy nodes to recompute session protocol ceilings", () => {
    const close = vi.fn();
    const client = makeClient({
      connect: {
        ...makeClient().connect,
        minProtocol: PROTOCOL_VERSION - 1,
        maxProtocol: PROTOCOL_VERSION - 1,
        caps: [],
      },
    });
    expect(
      reconcileClientPluginNodeCapabilities(client, { files: { surface: "files" } }, close),
    ).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  test("revokes changed node capabilities while preserving current nodes and operators", () => {
    const surface = { surface: "files", scopeKey: "publisher:files", ttlMs: 200 };
    const surfaces = indexPluginNodeCapabilitySurfaces([surface]);
    const close = vi.fn();
    const changed = makeClient({
      connect: { ...makeClient().connect, caps: [] },
      pluginSurfaceUrls: { files: "https://gateway.example/__openclaw__/cap/current-token" },
      pluginNodeCapabilitySurfaces: { files: { ...surface, ttlMs: 100 } },
      pluginNodeCapabilities: {
        "files\0publisher:files": { capability: "current-token", expiresAtMs: 2_000 },
      },
    });
    changed.socket.close = close;
    const current = makeClient({ pluginNodeCapabilitySurfaces: surfaces });
    const operator = makeClient({ connect: { ...current.connect, role: "operator" } });

    expect(reconcileClientPluginNodeCapabilities(changed, surfaces)).toBe(false);
    expect(reconcileClientPluginNodeCapabilities(current, surfaces)).toBe(true);
    expect(reconcileClientPluginNodeCapabilities(operator, surfaces)).toBe(true);
    expect(close).toHaveBeenCalledExactlyOnceWith(1012, "node capabilities changed");
    expect(current.invalidated).toBeUndefined();
    expect(operator.invalidated).toBeUndefined();
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: [changed],
        surface,
        capability: "current-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  test("refreshes client plugin surface url and stored capability", () => {
    const client = makeClient({
      pluginSurfaceUrls: {
        canvas: "http://127.0.0.1:18789/__openclaw__/cap/old-token",
      },
      pluginNodeCapabilitySurfaces: {
        canvas: { surface: "canvas", ttlMs: 100 },
      },
    });
    const refreshed = refreshClientPluginNodeCapability({
      client,
      surface: { surface: "canvas" },
      nowMs: 1_000,
    });
    expect(refreshed?.surface).toBe("canvas");
    expect(refreshed?.expiresAtMs).toBe(1_100);
    expect(refreshed?.capability).toBeTypeOf("string");
    expect(refreshed?.capability).not.toBe("");
    expect(refreshed?.scopedUrl).toContain("/__openclaw__/cap/");
    expect(refreshed?.scopedUrl).not.toContain("old-token/__openclaw__/cap/");
    expect(client.pluginSurfaceUrls?.canvas).toBe(refreshed?.scopedUrl);
    expect(client.pluginNodeCapabilities?.canvas).toEqual({
      capability: refreshed?.capability,
      expiresAtMs: 1_100,
    });
  });

  test("does not refresh client plugin capabilities when the clock is invalid", () => {
    const client = makeClient({
      pluginSurfaceUrls: {
        canvas: "http://127.0.0.1:18789/__openclaw__/cap/old-token",
      },
      pluginNodeCapabilitySurfaces: {
        canvas: { surface: "canvas", ttlMs: 100 },
      },
    });

    expect(
      refreshClientPluginNodeCapability({
        client,
        surface: { surface: "canvas" },
        nowMs: Number.NaN,
      }),
    ).toBeUndefined();
    expect(client.pluginSurfaceUrls?.canvas).toBe(
      "http://127.0.0.1:18789/__openclaw__/cap/old-token",
    );
    expect(client.pluginNodeCapabilities).toBeUndefined();
  });

  test("authorizes matching plugin surface capabilities and slides expiry", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });
    const clients = new Set([client]);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(true);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_100);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas" },
        capability: "wrong",
        nowMs: 1_000,
      }),
    ).toBe(false);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "files" },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  test("rejects invalidated clients without sliding capability expiry", () => {
    const client = makeClient({
      invalidated: true,
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });

    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_500);
  });

  test("rejects plugin surface capabilities when the clock is invalid", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: Number.NaN,
      }),
    ).toBe(false);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_500);
  });

  test("rejects plugin surface capabilities with invalid stored expiries", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: Number.POSITIVE_INFINITY },
      },
    });
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  test("does not authorize the same surface token for a different plugin scope", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        "canvas\u0000canvas-plugin:canvas": { capability: "canvas-token", expiresAtMs: 1_500 },
      },
    });
    const clients = new Set([client]);

    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas", scopeKey: "other-plugin:canvas" },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients,
        surface: { surface: "canvas", scopeKey: "canvas-plugin:canvas", ttlMs: 100 },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(true);
  });

  test("rejects expired capabilities", () => {
    const client = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability: "canvas-token", expiresAtMs: 999 },
      },
    });
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([client]),
        surface: { surface: "canvas" },
        capability: "canvas-token",
        nowMs: 1_000,
      }),
    ).toBe(false);
  });

  test("requires approved node surfaces while preserving operator capabilities", () => {
    const capability = "canvas-token";
    const surface = { surface: "canvas" };
    const pendingNode = makeClient(
      {
        pluginNodeCapabilities: {
          canvas: { capability, expiresAtMs: 1_500 },
        },
      },
      [],
    );
    const operator = makeClient({
      pluginNodeCapabilities: {
        canvas: { capability, expiresAtMs: 1_500 },
      },
    });
    operator.connect.role = "operator";

    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([pendingNode]),
        surface,
        capability,
        nowMs: 1_000,
      }),
    ).toBe(false);
    expect(
      hasAuthorizedPluginNodeCapability({
        clients: new Set([operator]),
        surface,
        capability,
        nowMs: 1_000,
      }),
    ).toBe(true);
  });
});

/* --- boundary-proof coverage (merged from server.plugin-node-capability-boundary-proof.test.ts: the gateway-root shard caps test roots at 720) --- */
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
type BoundaryResult = { http?: number; ws?: number; dispatches: DispatchCounts };

function scheduleCapabilityRevocationAfterAuthorization(params: {
  client: GatewayWsClient;
  nodeRegistry: NodeRegistry;
  nodeId: string;
}): Promise<void> {
  let liveCaps = ["canvas"];
  let authorizationReads = 0;
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
      // The first read belongs to initial capability authentication. Return
      // the live snapshot for the outer recheck, then revoke the registry
      // before the lazy plugin owner reaches its final dispatch callback.
      const currentCaps = liveCaps;
      if (authorizationReads === 2) {
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
  return await new Promise<number>((resolve, reject) => {
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
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("expected capability rejection"));
    });
    req.once("error", reject);
    req.end();
  });
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
    await run(address.port, clients, () => ({ http: httpDispatches, ws: wsDispatches }));
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
        await runBoundaryProof(async (port, clients, dispatches) => {
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
              });
              const raceWs = await requestWsStatus(
                port,
                scopedPath(raceWsCapability, CANVAS_WS_PATH),
              );
              await revocation;
              expect(raceWs).toBe(401);
              expect(dispatches()).toEqual({ http: 0, ws: 0 });
              proof.raceWs = {
                ws: raceWs,
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
