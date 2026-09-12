import { once } from "node:events";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import type { GatewayWsClient } from "./server/ws-types.js";

describe("Gateway startup node capabilities", () => {
  it("reconnects affected nodes when plugins attach after their handshake", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "gateway-startup-node-capabilities",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        VITEST: "1",
      },
    });
    const previousRegistry = captureActivePluginRegistrySnapshot();
    const registry = createEmptyPluginRegistry();
    registry.httpRoutes.push({
      pluginId: "files",
      path: "/files",
      match: "prefix",
      auth: "gateway",
      nodeCapability: { surface: "files" },
      handler: async () => true,
    });
    const peerServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const peerSockets: WebSocket[] = [];
    onTestFinished(async () => {
      for (const socket of [...peerSockets, ...peerServer.clients]) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        peerServer.close((error) => (error ? reject(error) : resolve()));
      });
    });
    await once(peerServer, "listening");
    const address = peerServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a loopback WebSocket listener");
    }
    const connectPeer = async (name: string, role: "node" | "operator", caps: string[]) => {
      const accepted = new Promise<WebSocket>((resolve) => {
        peerServer.once("connection", (socket) => resolve(socket));
      });
      const peer = new WebSocket(`ws://127.0.0.1:${address.port}`);
      peerSockets.push(peer);
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        peer.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      await once(peer, "open");
      const socket = await accepted;
      const client: GatewayWsClient = {
        socket,
        connId: name,
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "openclaw-macos", version: "test", platform: "darwin", mode: "node" },
          role,
          caps,
        },
        pluginNodeCapabilitySurfaces: {},
      };
      return { client, closed };
    };
    const affected = await connectPeer("affected", "node", ["files"]);
    const unaffected = await connectPeer("unaffected", "node", ["camera"]);
    const operator = await connectPeer("operator", "operator", ["files"]);
    const peers = [affected, unaffected, operator];
    let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
    let server: GatewayServer | undefined;
    const createKernel = createGatewayKernel;
    const factory = vi
      .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
      .mockImplementation(async (...args) => {
        kernel = await createKernel(...args);
        for (const { client } of peers) {
          kernel.clients.add(client);
        }
        return kernel;
      });
    const postAttach = vi
      .spyOn(await import("./server-startup-post-attach.js"), "startGatewayPostAttachRuntime")
      .mockImplementation(async (params) => {
        await params.onStartupPluginsLoaded?.({ pluginRegistry: registry, gatewayMethods: [] });
        return { stopGatewayUpdateCheck: async () => {}, startupSettled: Promise.resolve() };
      });
    try {
      const token = "startup-node-capability-token";
      await state.writeConfig({
        gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      });
      state.applyEnv();
      stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
      const { startGatewayServerCore } = await import("./server-start.js");
      server = await startGatewayServerCore(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
      expect(affected.client.invalidated).toBe(true);
      await expect(affected.closed).resolves.toEqual({
        code: 1012,
        reason: "node capabilities changed",
      });
      expect(unaffected.client.socket.readyState).toBe(WebSocket.OPEN);
      expect(operator.client.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      kernel?.clients.clear();
      try {
        await server?.close();
      } finally {
        factory.mockRestore();
        postAttach.mockRestore();
        restoreActivePluginRegistrySnapshot(previousRegistry);
        await state.cleanup();
      }
    }
  });
});
