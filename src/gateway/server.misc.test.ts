import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveCanvasHostUrl } from "../infra/canvas-host-url.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin } from "../test-utils/channel-plugins.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  occupyPort,
  onceMessage,
  startGatewayServer,
  startServerWithClient,
  testState,
  testTailnetIPv4,
} from "./test-helpers.js";

installGatewayTestHooks();

const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ deps, to, text }) => {
    if (!deps?.sendWhatsApp) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return { channel: "whatsapp", ...(await deps.sendWhatsApp(to, text, {})) };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    if (!deps?.sendWhatsApp) {
      throw new Error("Missing sendWhatsApp dep");
    }
    return { channel: "whatsapp", ...(await deps.sendWhatsApp(to, text, { mediaUrl })) };
  },
};

const whatsappPlugin = createOutboundTestPlugin({
  id: "whatsapp",
  outbound: whatsappOutbound,
  label: "WhatsApp",
});

const createRegistry = (channels: PluginRegistry["channels"]): PluginRegistry => ({
  plugins: [],
  tools: [],
  channels,
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  cliRegistrars: [],
  services: [],
  diagnostics: [],
});

const whatsappRegistry = createRegistry([
  {
    pluginId: "whatsapp",
    source: "test",
    plugin: whatsappPlugin,
  },
]);
const emptyRegistry = createRegistry([]);

describe("gateway server misc", () => {
  test("hello-ok advertises the gateway port for canvas host", async () => {
    const prevToken = process.env.CLAWDBOT_GATEWAY_TOKEN;
    const prevCanvasPort = process.env.CLAWDBOT_CANVAS_HOST_PORT;
    process.env.CLAWDBOT_GATEWAY_TOKEN = "secret";
    testTailnetIPv4.value = "100.64.0.1";
    testState.gatewayBind = "lan";
    const canvasPort = await getFreePort();
    testState.canvasHostPort = canvasPort;
    process.env.CLAWDBOT_CANVAS_HOST_PORT = String(canvasPort);

    const port = await getFreePort();
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort,
      requestHost: `100.64.0.1:${port}`,
      localAddress: "127.0.0.1",
    });
    expect(canvasHostUrl).toBe(`http://100.64.0.1:${canvasPort}`);
    if (prevToken === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
    if (prevCanvasPort === undefined) {
      delete process.env.CLAWDBOT_CANVAS_HOST_PORT;
    } else {
      process.env.CLAWDBOT_CANVAS_HOST_PORT = prevCanvasPort;
    }
  });

  test("send dedupes by idempotencyKey", { timeout: 60_000 }, async () => {
    const prevRegistry = getActivePluginRegistry() ?? emptyRegistry;
    try {
      const { server, ws } = await startServerWithClient();
      await connectOk(ws);
      setActivePluginRegistry(whatsappRegistry);
      expect(getChannelPlugin("whatsapp")).toBeDefined();

      const idem = "same-key";
      const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
      const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
      const sendReq = (id: string) =>
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method: "send",
            params: { to: "+15550000000", message: "hi", idempotencyKey: idem },
          }),
        );
      sendReq("a1");
      sendReq("a2");

      const res1 = await res1P;
      const res2 = await res2P;
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(res1.payload).toEqual(res2.payload);
      ws.close();
      await server.close();
    } finally {
      setActivePluginRegistry(prevRegistry);
    }
  });

  test("auto-enables configured channel plugins on startup", async () => {
    const configPath = process.env.CLAWDBOT_CONFIG_PATH;
    if (!configPath) throw new Error("Missing CLAWDBOT_CONFIG_PATH");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          channels: {
            discord: {
              token: "token-123",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    await server.close();

    const updated = JSON.parse(await fs.readFile(configPath, "utf-8")) as Record<string, unknown>;
    const plugins = updated.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const discord = entries?.discord as Record<string, unknown> | undefined;
    expect(discord?.enabled).toBe(true);
    expect((updated.channels as Record<string, unknown> | undefined)?.discord).toMatchObject({
      token: "token-123",
    });
  });

  test("refuses to start when port already bound", async () => {
    const { server: blocker, port } = await occupyPort();
    await expect(startGatewayServer(port)).rejects.toBeInstanceOf(GatewayLockError);
    await expect(startGatewayServer(port)).rejects.toThrow(/already listening/i);
    blocker.close();
  });

  test("releases port after close", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    await server.close();

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
