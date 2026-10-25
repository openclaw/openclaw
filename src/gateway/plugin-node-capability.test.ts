import { describe, expect, test, vi } from "vitest";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
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
  type PluginNodeCapabilitySurface,
} from "./plugin-node-capability.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function makeClient(overrides: Partial<GatewayWsClient> = {}): GatewayWsClient {
  return {
    socket: {} as GatewayWsClient["socket"],
    connect: {
      role: "node",
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { mode: "node" },
    } as GatewayWsClient["connect"],
    connId: "node-1",
    usesSharedGatewayAuth: false,
    ...overrides,
  };
}

function authorizedUrl(
  client: GatewayWsClient,
  surface: PluginNodeCapabilitySurface,
  url: string,
  nowMs?: number,
) {
  const now = nowMs ?? Date.now();
  using _ = vi.spyOn(Date, "now").mockReturnValueOnce(now);
  return hasAuthorizedClientPluginNodeCapabilityUrl({ client, surface, url });
}

function authorizeCapability(
  client: GatewayWsClient,
  surface: PluginNodeCapabilitySurface = { surface: "canvas", ttlMs: 100 },
  capability = "canvas-token",
  nowMs = 1_000,
) {
  using _ = vi.spyOn(Date, "now").mockReturnValueOnce(nowMs);
  return hasAuthorizedPluginNodeCapability({
    clients: new Set([client]),
    surface,
    capability,
  });
}

function makeRefreshClient() {
  return makeClient({
    pluginSurfaceUrls: { canvas: "http://127.0.0.1:18789/__openclaw__/cap/old-token" },
    pluginNodeCapabilitySurfaces: { canvas: { surface: "canvas", ttlMs: 100 } },
  });
}

function refresh(client: GatewayWsClient, surface = "canvas", nowMs = 1_000) {
  using _ = vi.spyOn(Date, "now").mockReturnValueOnce(nowMs);
  return refreshClientPluginNodeCapability({ client, surface: { surface } });
}

function makeTokenClient(expiresAtMs = 1_500, key = "canvas") {
  return makeClient({
    pluginNodeCapabilities: { [key]: { capability: "canvas-token", expiresAtMs } },
  });
}

const canvas = { surface: "canvas", scopeKey: "drawing:canvas" };
const files = { surface: "files", scopeKey: "storage:files" };
const scopedUrl = (token: string, host = "https://gateway.example") =>
  `${host}/__openclaw__/cap/${token}`;

describe("plugin node capability helpers", () => {
  test("publishes plugin surface replacement atomically while retaining unaffected credentials", () => {
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
    expect(authorizedUrl(client, canvas, previous.canvas!)).toBe(true);
    publish();
    expect(client.pluginSurfaceUrls?.files).toBe(previous.files);
    expect(client.pluginSurfaceUrls?.retired).toBeUndefined();
    expect(authorizedUrl(client, canvas, previous.canvas!)).toBe(false);
    expect(authorizedUrl(client, removed, previous.retired!)).toBe(false);
    expect(authorizedUrl(client, canvas, client.pluginSurfaceUrls!.canvas!)).toBe(true);
  });

  test("publishes newly enabled surfaces only within the client's admitted capabilities", () => {
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
    expect(authorizedUrl(client, canvas, client.pluginSurfaceUrls!.canvas!)).toBe(true);
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

  test.each([
    [
      "token%20value",
      "file.txt?download=1",
      "token value",
      "file.txt?download=1&oc_cap=token+value",
    ],
    ["current-token", "?oc_cap=stale-token", "current-token", "?oc_cap=current-token"],
  ] as const)(
    "normalizes scoped capability %s over any stale query",
    (token, suffix, capability, rewritten) => {
      expect(
        normalizePluginNodeCapabilityScopedUrl(
          `/__openclaw__/cap/${token}/__openclaw__/canvas/${suffix}`,
        ),
      ).toEqual({
        pathname: `/__openclaw__/canvas/${suffix.split("?")[0]}`,
        capability,
        rewrittenUrl: `/__openclaw__/canvas/${rewritten}`,
        scopedPath: true,
        malformedScopedPath: false,
      });
    },
  );

  test("detects conflicting scoped host capabilities across rewritten hosts", () => {
    expect(
      pluginNodeCapabilityScopedHostUrlsConflict(
        scopedUrl("token%20value", "http://127.0.0.1:18789"),
        scopedUrl("token%20value", "https://gateway.example:7443"),
      ),
    ).toBe(false);
    expect(
      pluginNodeCapabilityScopedHostUrlsConflict(scopedUrl("old-token"), scopedUrl("new-token")),
    ).toBe(true);
    expect(pluginNodeCapabilityScopedHostUrlsConflict("not-a-url", "also-not-a-url")).toBe(false);
  });

  test("validates a current scoped URL without extending its authorization", () => {
    const client = makeClient({
      pluginNodeCapabilities: { canvas: { capability: "current-token", expiresAtMs: 1_500 } },
    });
    const surface = { surface: "canvas" };
    const url = scopedUrl("current-token");
    expect(authorizedUrl(client, surface, url, 1_000)).toBe(true);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_500);
    expect(authorizedUrl(client, surface, scopedUrl("other-token"), 1_000)).toBe(false);
    expect(authorizedUrl(client, surface, url, 1_500)).toBe(false);
    expect(authorizedUrl(makeClient(), surface, url, 1_000)).toBe(false);
    expect(
      authorizedUrl(client, { surface: "canvas", scopeKey: "other-plugin:canvas" }, url, 1_000),
    ).toBe(false);
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

  test("preserves nodes across unrelated hosted-surface changes", () => {
    const close = vi.fn();
    const client = makeClient({
      connect: { ...makeClient().connect, caps: ["browser"] },
    });
    const surfaces = indexPluginNodeCapabilitySurfaces([files]);
    expect(reconcileClientPluginNodeCapabilities(client, surfaces, close)).toBe(true);
    expect(client.invalidated).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(refresh(client, "files")).toBeUndefined();
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
    expect(authorizeCapability(changed, surface, "current-token")).toBe(false);
  });

  test("refreshes client plugin surface url and stored capability", () => {
    const client = makeRefreshClient();
    const refreshed = refresh(client);
    expect(refreshed).toMatchObject({ surface: "canvas", expiresAtMs: 1_100 });
    expect(refreshed?.scopedUrl).not.toContain("old-token/__openclaw__/cap/");
    expect(authorizeCapability(client, undefined, refreshed?.capability)).toBe(true);
  });

  test("does not refresh client plugin capabilities when the clock is invalid", () => {
    const client = makeRefreshClient();

    expect(refresh(client, "canvas", Number.NaN)).toBeUndefined();
    expect(client.pluginSurfaceUrls?.canvas).toBe(
      "http://127.0.0.1:18789/__openclaw__/cap/old-token",
    );
    expect(client.pluginNodeCapabilities).toBeUndefined();
  });

  test("authorizes matching plugin surface capabilities and slides expiry", () => {
    const client = makeTokenClient();
    expect(authorizeCapability(client)).toBe(true);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(1_100);
    expect(authorizeCapability(client, { surface: "canvas" }, "wrong")).toBe(false);
    expect(authorizeCapability(client, { surface: "files" })).toBe(false);
  });

  test.each([
    ["invalid clock", 1_500, Number.NaN],
    ["invalid expiry", Number.POSITIVE_INFINITY, 1_000],
  ] as const)("rejects %s without sliding expiry", (_name, expiresAtMs, now) => {
    const client = makeTokenClient(expiresAtMs);
    expect(authorizeCapability(client, undefined, undefined, now)).toBe(false);
    expect(client.pluginNodeCapabilities?.canvas?.expiresAtMs).toBe(expiresAtMs);
  });

  test("stores independent same-surface credentials and authorizes only their plugin scope", () => {
    const client = makeClient();
    const first = { surface: "canvas", scopeKey: "canvas-plugin:canvas", ttlMs: 100 };
    const second = { surface: "canvas", scopeKey: "other-plugin:canvas", ttlMs: 100 };
    setClientPluginNodeCapability({
      client,
      surface: first,
      capability: "canvas-token",
      expiresAtMs: 1500,
    });
    setClientPluginNodeCapability({
      client,
      surface: second,
      capability: "other-token",
      expiresAtMs: 1500,
    });
    expect(authorizeCapability(client, second)).toBe(false);
    expect(authorizeCapability(client, first)).toBe(true);
    expect(authorizeCapability(client, second, "other-token")).toBe(true);
    expect(client.pluginNodeCapabilities).toEqual({
      "canvas\0canvas-plugin:canvas": { capability: "canvas-token", expiresAtMs: 1100 },
      "canvas\0other-plugin:canvas": { capability: "other-token", expiresAtMs: 1100 },
    });
  });
});
