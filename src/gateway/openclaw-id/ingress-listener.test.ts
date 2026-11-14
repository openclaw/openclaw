import fs from "node:fs";
import http, { type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { syntheticPeerAddress } from "../../../packages/openclaw-id-protocol/src/index.js";
import {
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  type GatewayAuthResult,
} from "../auth.js";
import { prepareGatewayIngressAttribution } from "../ingress-attribution.js";
import { isLocalDirectRequest } from "../net.js";
import {
  startOpenClawIdIngressListener,
  type OpenClawIdIngressListener,
} from "./ingress-listener.js";
import { upstreamHeaders } from "./tunnel-child/headers.js";
import { setOpenClawIdTunnelPrincipalResolver } from "./tunnel-principal.js";

const PEER_KEY: `iroh:${string}` = `iroh:${"ab".repeat(32)}`;

type Seen = {
  req: IncomingMessage;
  attribution: ReturnType<typeof prepareGatewayIngressAttribution>;
  auth?: GatewayAuthResult;
};

let dir: string | undefined;
let started: OpenClawIdIngressListener | undefined;
let gateway: http.Server | undefined;

afterEach(async () => {
  setOpenClawIdTunnelPrincipalResolver(undefined);
  await started?.close();
  gateway?.close();
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  started = gateway = dir = undefined;
});

// A stand-in for the Gateway's primary listener: records how the ingress
// attribution owner classifies each request it receives.
async function setup(authenticate = false) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocid-ingress-"));
  const seen: Seen[] = [];
  const observe = async (req: IncomingMessage, ws = false) => {
    const auth = {
      mode: "trusted-proxy" as const,
      allowTailscale: true,
      trustedProxy: {
        userHeader: "custom-user",
        requiredHeaders: ["custom-proof"],
        allowLoopback: true,
      },
    };
    const attribution = prepareGatewayIngressAttribution({
      req,
      trustedProxies: ["127.0.0.1"],
      trustedProxy: auth.trustedProxy,
    });
    seen.push({
      req,
      attribution,
      ...(authenticate
        ? {
            auth: await (ws ? authorizeWsControlUiGatewayConnect : authorizeHttpGatewayConnect)({
              req,
              auth,
              ingressAttribution: attribution,
              trustedProxies: ["127.0.0.1"],
            }),
          }
        : {}),
    });
  };
  gateway = http.createServer((req, res) => {
    void observe(req).then(() => res.end("gateway"));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  gateway.on("upgrade", (req, socket, head) => {
    void observe(req, true).then(() => {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(1000, "ok"));
    });
  });
  const log = { warn: vi.fn() };
  started = await startOpenClawIdIngressListener({
    socketPath: path.join(dir, "openclaw-id", "ingress.sock"),
    gatewayServer: () => gateway,
    log,
  });
  return { seen, log, listener: started };
}

function request(socketPath: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ socketPath, path: "/claw/", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("OpenClaw ID ingress listener", () => {
  it("ignores proxy identity on real HTTP and WS ingress in trusted-proxy mode", async () => {
    const { seen, listener } = await setup(true);
    setOpenClawIdTunnelPrincipalResolver(async (peerKey) => ({
      kind: "member",
      peerKey,
      accountId: "viewer-account",
      role: "viewer",
    }));
    for (const kind of ["http", "ws"] as const) {
      const headers = upstreamHeaders(
        [
          ["CF-Access-Authenticated-User-Email", "admin@example.test"],
          ["CF-Access-JWT-Assertion", "forged"],
          ["Tailscale-User-Login", "admin@example.test"],
          ["X-Forwarded-For", "127.0.0.1"],
          ["custom-user", "admin@example.test"],
          ["custom-proof", "forged"],
        ],
        {
          peerKey: PEER_KEY,
          proxyToken: listener.proxyToken,
          peerAddress: await syntheticPeerAddress(PEER_KEY),
          forwardedProto: "https",
        },
        kind,
      );
      if (kind === "http") {
        expect((await request(listener.socketPath, headers as Record<string, string>)).status).toBe(
          200,
        );
      } else {
        const ws = new WebSocket(`ws+unix:${listener.socketPath}:/`, { headers });
        await new Promise<void>((resolve, reject) => {
          ws.on("close", () => resolve());
          ws.on("error", reject);
        });
      }
      const received = seen.at(-1)!;
      expect(received.attribution.kind).toBe("openclaw-id-tunnel");
      expect(received.auth).toMatchObject({
        ok: true,
        method: "trusted-proxy",
        user: "openclaw-id:viewer-account",
        openclawId: { kind: "member", role: "viewer" },
      });
      expect(received.req.headers["cf-access-jwt-assertion"]).toBeUndefined();
      expect(received.req.headers["tailscale-user-login"]).toBeUndefined();
      expect(received.req.headers["custom-user"]).toBe("admin@example.test");
    }
  });

  it("listens on a socket only the Gateway user can open", async () => {
    const { listener } = await setup();
    if (process.platform !== "win32") {
      expect(fs.statSync(listener.socketPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(listener.socketPath)).mode & 0o777).toBe(0o700);
    }
    expect(listener.proxyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("marks relayed requests as tunnel traffic with the authenticated peer key, never as loopback", async () => {
    const { seen, listener } = await setup();
    const response = await request(listener.socketPath, {
      "x-openclaw-id-proxy-token": listener.proxyToken,
      "x-openclaw-id-peer-key": PEER_KEY,
      "x-forwarded-for": "fd69:726f:6800::1",
    });
    expect(response).toEqual({ status: 200, body: "gateway" });
    const { req, attribution } = seen[0]!;
    expect(attribution).toMatchObject({
      kind: "openclaw-id-tunnel",
      peerKey: PEER_KEY,
      clientIp: await syntheticPeerAddress(PEER_KEY),
      rateLimit: { subject: { key: `openclaw-id:${PEER_KEY}` } },
    });
    expect(isLocalDirectRequest(req)).toBe(false);
    // The contract headers never reach Gateway handlers or anything they forward to.
    expect(req.headers["x-openclaw-id-proxy-token"]).toBeUndefined();
    expect(req.headers["x-openclaw-id-peer-key"]).toBeUndefined();
    expect(req.rawHeaders.map((name) => name.toLowerCase())).not.toContain(
      "x-openclaw-id-proxy-token",
    );
  });

  it("keeps headersDistinct readable after the contract headers are stripped", async () => {
    const { seen, listener } = await setup();
    const response = await request(listener.socketPath, {
      "x-openclaw-id-proxy-token": listener.proxyToken,
      "x-openclaw-id-peer-key": PEER_KEY,
      "if-modified-since": "Sat, 31 Oct 2026 00:00:00 GMT",
    });
    expect(response.status).toBe(200);
    const { req } = seen[0]!;
    expect(req.headersDistinct["if-modified-since"]).toEqual(["Sat, 31 Oct 2026 00:00:00 GMT"]);
    expect(req.headersDistinct["x-openclaw-id-proxy-token"]).toBeUndefined();
    expect(req.headersDistinct["x-openclaw-id-peer-key"]).toBeUndefined();
  });

  it.each<[string, (token: string) => Record<string, string>]>([
    ["no token", () => ({ "x-openclaw-id-peer-key": PEER_KEY })],
    [
      "a wrong token",
      () => ({ "x-openclaw-id-proxy-token": "x".repeat(43), "x-openclaw-id-peer-key": PEER_KEY }),
    ],
    ["no peer key", (token) => ({ "x-openclaw-id-proxy-token": token })],
    [
      "a malformed peer key",
      (token) => ({ "x-openclaw-id-proxy-token": token, "x-openclaw-id-peer-key": "iroh:ZZ" }),
    ],
  ])("refuses a request with %s before the Gateway sees it", async (_label, headers) => {
    const { seen, listener, log } = await setup();
    const response = await request(listener.socketPath, headers(listener.proxyToken));
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it("marks relayed WebSocket upgrades and refuses forged ones", async () => {
    const { seen, listener } = await setup();
    const open = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws+unix:${listener.socketPath}:/`, { headers });
        ws.on("close", (code) => resolve(code));
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => {});
      });
    expect(
      await open({ "x-openclaw-id-proxy-token": "forged", "x-openclaw-id-peer-key": PEER_KEY }),
    ).toBe(403);
    expect(seen).toHaveLength(0);
    expect(
      await open({
        "x-openclaw-id-proxy-token": listener.proxyToken,
        "x-openclaw-id-peer-key": PEER_KEY,
      }),
    ).toBe(1000);
    expect(seen[0]!.attribution.kind).toBe("openclaw-id-tunnel");
  });

  it("hands tunnel API requests to the API handler with the authenticated peer key", async () => {
    const { seen, listener } = await setup();
    await started!.close();
    const calls: string[] = [];
    started = await startOpenClawIdIngressListener({
      socketPath: listener.socketPath,
      gatewayServer: () => gateway,
      log: { warn: vi.fn() },
      handleApi: async (req, res, peerKey) => {
        calls.push(`${req.url} ${peerKey}`);
        res.end("api");
      },
    });
    const api = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { socketPath: started!.socketPath, path: "/_openclaw-id/v1/membership", headers },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    expect(
      await api({
        "x-openclaw-id-proxy-token": "x".repeat(43),
        "x-openclaw-id-peer-key": PEER_KEY,
      }),
    ).toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
    expect(
      await api({
        "x-openclaw-id-proxy-token": started.proxyToken,
        "x-openclaw-id-peer-key": PEER_KEY,
      }),
    ).toEqual({ status: 200, body: "api" });
    expect(calls).toEqual([`/_openclaw-id/v1/membership ${PEER_KEY}`]);
    expect(seen).toHaveLength(0);
  });

  it("issues a new proxy token each time it starts", async () => {
    const first = (await setup()).listener.proxyToken;
    await started!.close();
    started = await startOpenClawIdIngressListener({
      socketPath: path.join(dir!, "openclaw-id", "ingress.sock"),
      gatewayServer: () => gateway,
      log: { warn: vi.fn() },
    });
    expect(started.proxyToken).not.toBe(first);
  });
});
