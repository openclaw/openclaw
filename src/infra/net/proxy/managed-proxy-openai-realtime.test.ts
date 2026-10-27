// Real OpenAI voice sockets must use Proxyline's managed routing, including on Bun.
import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
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

it.each([true, false])(
  "routes realtime voice through the managed proxy (admit=%s), without direct fallback",
  async (admit) => {
    const { port, proxyUrl, connects, authorizations } = await startNetwork(admit);
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", undefined);
    const handle = await startProxy({ proxyUrl, loopbackMode: admit ? "gateway-only" : "proxy" });
    closers.push(() => stopProxy(handle));
    // Admission needs proxy DNS; refusal uses a directly reachable target to detect bypass.
    const authority = `${admit ? "realtime.openai.test" : "127.0.0.1"}:${port}`;
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-realtime-key", baseUrl: `ws://${authority}/v1/realtime` },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    closers.push(() => bridge.close());
    if (admit) {
      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
    } else {
      await expect(bridge.connect()).rejects.toThrow();
    }
    expect(connects).toEqual([authority]);
    expect(authorizations).toEqual(admit ? ["Bearer test-realtime-key"] : []);
  },
  15_000,
);

function closeAfterEach(server: { close(callback: () => void): unknown }, disconnect: () => void) {
  closers.push(async () => {
    disconnect();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
}

async function startNetwork(admit: boolean) {
  const target = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const authorizations: string[] = [];
  target.on("connection", (socket, request) => {
    authorizations.push(request.headers.authorization ?? "");
    socket.on("message", (data) => {
      const event = JSON.parse(rawDataToString(data)) as { type?: string };
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated" }));
      }
    });
  });
  await once(target, "listening");
  closeAfterEach(target, () => target.clients.forEach((client) => client.terminate()));
  const port = (target.address() as AddressInfo).port;
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
  closeAfterEach(server, () => sockets.forEach((socket) => socket.destroy()));
  const proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { port, proxyUrl, connects, authorizations };
}
