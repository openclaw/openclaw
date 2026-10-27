import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startWarmReloadAdmission } from "../../scripts/perf/warm-reload-admission.ts";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.ts";

let upstream: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
let admission: Awaited<ReturnType<typeof startWarmReloadAdmission>>;
let websocket: WebSocketServer;
let requests = 0;
const observed = (req: IncomingMessage) => {
  requests++;
  return { path: req.url, headers: req.headers };
};
beforeAll(async () => {
  upstream = await reserveTestPortListener({
    port: 19692,
    offsets: [0, 1, 2],
    createListener: () =>
      createServer((req, res) => {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.end(JSON.stringify(observed(req)));
      }),
  });
  websocket = new WebSocketServer({ server: upstream.listener });
  websocket.on("connection", (peer, req) => peer.send(JSON.stringify(observed(req))));
  admission = await startWarmReloadAdmission({
    gatewayPort: upstream.claim.port,
    port: upstream.claim.port + 2,
  });
});
afterAll(async () => {
  await admission?.close();
  for (const peer of websocket?.clients ?? []) {
    peer.terminate();
  }
  if (websocket) {
    await new Promise<void>((resolve) => {
      websocket.close(() => resolve());
    });
  }
  await upstream?.releaseListener();
  await upstream?.claim.release();
});

it("rejects the native sandbox companion port before opening admission", async () => {
  let opened: Awaited<ReturnType<typeof startWarmReloadAdmission>> | undefined;
  try {
    await expect(
      startWarmReloadAdmission({
        gatewayPort: upstream.claim.port,
        port: upstream.claim.port + 1,
      }).then((value) => {
        opened = value;
        return "listener opened";
      }),
    ).rejects.toThrow("native sandbox");
  } finally {
    await opened?.close();
  }
});

it("requires the synthetic session and replaces browser-supplied authority on HTTP and WebSocket", async () => {
  const forged = {
    "x-forwarded-user": "intruder@example.invalid",
    "x-forwarded-for": "127.0.0.1",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "other.example.invalid",
    "x-real-ip": "127.0.0.1",
    forwarded: "for=127.0.0.1",
    "x-openclaw-scopes": "operator.admin",
    authorization: "Bearer synthetic-forgery",
  };
  const denied = await fetch(`${admission.origin}/`, { headers: forged });
  expect(denied.status).toBe(401);
  await denied.text();
  const rejected = new WebSocket(admission.origin.replace("http:", "ws:"), {
    headers: { ...forged, cookie: `${admission.browserCookie.name}=incorrect` },
  });
  const [error] = await once(rejected, "error");
  expect(error.message).toContain("401");
  expect(requests).toBe(0);

  const cookie = `${admission.browserCookie.name}=${admission.browserCookie.value}; retained=native`;
  const response = await fetch(`${admission.origin}/chat/main/fixture?draft=ready`, {
    headers: { ...forged, cookie },
  });
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  const body: unknown = await response.json();
  const trusted = {
    "x-forwarded-user": "proof-operator@example.invalid",
    "x-forwarded-for": "198.51.100.248",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "127.0.0.1:19694",
    cookie: "retained=native",
  };
  expect(body).toMatchObject({ path: "/chat/main/fixture?draft=ready", headers: trusted });
  const serialized = JSON.stringify(body);
  for (const forbidden of ["intruder", "synthetic-forgery", "x-openclaw-scopes", "x-real-ip"]) {
    expect(serialized).not.toContain(forbidden);
  }
  const client = new WebSocket(`${admission.origin.replace("http:", "ws:")}/ws`, {
    headers: { ...forged, cookie },
  });
  const [message] = await once(client, "message");
  expect(JSON.parse(message.toString())).toMatchObject({ path: "/ws", headers: trusted });
  const closed = once(client, "close");
  client.close();
  await closed;
});

it("binds each synthetic viewer identity to its own cookie", async () => {
  for (const [index, peer] of admission.peerSessions.entries()) {
    const response = await fetch(`${admission.origin}/`, {
      headers: {
        cookie: `${peer.cookie.name}=${peer.cookie.value}`,
        "x-forwarded-user": admission.viewerEmail,
      },
    });
    expect(await response.json()).toMatchObject({
      headers: { "x-forwarded-user": `proof-viewer-${index + 1}@example.invalid` },
    });
  }
});
