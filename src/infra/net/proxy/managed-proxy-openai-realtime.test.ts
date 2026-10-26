// Drives the bundled OpenAI realtime voice socket through the real managed proxy
// lifecycle, so Bun runs prove these sockets reach Proxyline's Gateway hooks.
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "../../../../packages/gateway-client/src/websocket.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/capability-provider.types.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { rawDataToString } from "../../ws.js";
import { startProxy, stopProxy } from "./proxy-lifecycle.js";

// Vitest aliases bare ws to the installed package, hiding Bun's production adapter.
// Resolve the runtime's actual package entry so this regression covers that boundary.
vi.mock("ws", async () => {
  const { createRequire } = await import("node:module");
  const ws: typeof import("ws") = createRequire(import.meta.url)("ws");
  return { ...ws, default: ws };
});

const { buildOpenAIRealtimeVoiceProvider } = await loadBundledPluginFacade<{
  buildOpenAIRealtimeVoiceProvider: () => RealtimeVoiceProviderPlugin;
}>({ pluginId: "openai", artifactBasename: "api.js" });

const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  try {
    for (const close of closers.splice(0).toReversed()) {
      await close();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("managed proxy routing for OpenAI realtime voice", () => {
  it("tunnels the realtime voice socket through the managed proxy", async () => {
    const target = await startRealtimeTarget();
    const proxy = await startForwardProxy(true);
    await startManagedProxy(proxy.url, "gateway-only");
    // Only the proxy reaches this host, like api.openai.com behind egress restrictions.
    const authority = `realtime.openai.test:${target.port}`;
    const bridge = createRealtimeBridge(`ws://${authority}/v1/realtime`);

    await bridge.connect();

    expect(bridge.isConnected()).toBe(true);
    expect(proxy.connects).toEqual([authority]);
    expect(target.authorizations).toEqual(["Bearer test-realtime-key"]);
  }, 15_000);

  it("fails closed without a direct connection when the managed proxy refuses", async () => {
    const target = await startRealtimeTarget();
    const proxy = await startForwardProxy(false);
    // Loopback mode "proxy" keeps this target directly reachable, so a bypass would connect.
    await startManagedProxy(proxy.url, "proxy");
    const authority = `127.0.0.1:${target.port}`;
    const bridge = createRealtimeBridge(`ws://${authority}/v1/realtime`);

    await expect(bridge.connect()).rejects.toThrow();

    expect(proxy.connects).toEqual([authority]);
    expect(target.authorizations).toEqual([]);
  }, 15_000);
});

async function startManagedProxy(proxyUrl: string, loopbackMode: "gateway-only" | "proxy") {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", undefined);
  const handle = await startProxy({ proxyUrl, loopbackMode });
  closers.push(() => stopProxy(handle));
}

function createRealtimeBridge(baseUrl: string) {
  const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "test-realtime-key", baseUrl },
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
  });
  closers.push(() => bridge.close());
  return bridge;
}

async function startRealtimeTarget() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const authorizations: string[] = [];
  server.on("connection", (socket, request) => {
    authorizations.push(request.headers.authorization ?? "");
    socket.on("message", (data) => {
      const event = JSON.parse(rawDataToString(data)) as { type?: string };
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated" }));
      }
    });
  });
  await once(server, "listening");
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, authorizations };
}

async function startForwardProxy(admit: boolean) {
  const connects: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => response.writeHead(405).end());
  server.on("connection", (socket) => sockets.add(socket));
  server.on("connect", (request, client: Socket, head: Buffer) => {
    const authority = request.url ?? "";
    connects.push(authority);
    if (!admit) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = connect(Number(authority.split(":").at(-1)), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  );
  return { connects, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
