// Real CLI, node-host auth, native credential storage, and WebSocket client.
// Only command capabilities and the remote Gateway protocol peer are fixtures.
import { once } from "node:events";
import fs from "node:fs/promises";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { RequestFrame } from "../../packages/gateway-protocol/src/index.js";
import { storeDeviceAuthToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { configureNodeHost, loadNodeHostConfig } from "../node-host/config.js";
import { encodePairingSetupCode } from "../pairing/setup-code.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { registerConnectCli } from "./connect-cli.js";

const fixture = vi.hoisted(() => ({
  connected: vi.fn(),
  runtime: { error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: fixture.runtime,
}));
// mock-isolation: No host plugins, subprocesses, or worker sessions are needed for authentication.
vi.mock("../node-host/runtime.js", () => ({
  prepareNodeHostRuntime: async () => ({
    manifest: { caps: [], commands: [] },
    workerHostingEnabled: false,
    preparedWorkspacesEnabled: false,
    nativeInferenceEnabled: false,
    initialInventory: { skills: [], pluginTools: [] },
    start: () => ({
      updateGatewayConnection: fixture.connected,
      cancelAll: async () => {},
      close: async () => {},
    }),
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function runConnect(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerConnectCli(program);
  await program.parseAsync(["connect", ...args], { from: "user" });
}

describe("connect setup-code replay", () => {
  it("reconnects an ephemeral node with its saved token without sending expired bootstrap auth", async () => {
    await withOpenClawTestState({ label: "connect-replay" }, async (state) => {
      const claim = await acquireTestPortBlock({ offsets: [0] });
      const server = new WebSocketServer({ host: "127.0.0.1", port: claim.port });
      const on = vi.spyOn(process, "on");
      const previousExitCode = process.exitCode;
      let running: Promise<void> | undefined;
      const connected = Promise.withResolvers<void>();
      fixture.connected.mockImplementation((value: unknown) => {
        if (value) {
          connected.resolve();
        }
      });
      // Ignore earlier import-time listeners: the foreground runner registers its
      // shutdown handler last, before opening the connection.
      const stop = () => on.mock.calls.findLast(([event]) => event === "SIGTERM")?.[1]?.("SIGTERM");
      const frames: RequestFrame[] = [];
      try {
        await once(server, "listening");
        const gateway = { host: "127.0.0.1", port: claim.port, tls: false };
        await configureNodeHost({ gateway, fallbackDisplayName: "Replay fixture" });
        const identity = loadOrCreateDeviceIdentity();
        await storeDeviceAuthToken({
          deviceId: identity.deviceId,
          role: "node",
          token: "synthetic-paired-node-token",
          scopes: [],
        });
        // Ambient auth must not turn an expired ticket into shared-credential enrollment.
        process.env.OPENCLAW_GATEWAY_TOKEN = "synthetic-unrelated-gateway-token";
        const code = encodePairingSetupCode({
          url: `ws://127.0.0.1:${claim.port}`,
          bootstrapToken: "synthetic-expired-bootstrap",
          expiresAtMs: 1,
        });
        const targetFile = state.path("setup-code");
        await fs.writeFile(targetFile, code, { mode: 0o600 });
        server.on("connection", (socket) => {
          socket.send(
            JSON.stringify({
              type: "event",
              event: "connect.challenge",
              payload: { nonce: "synthetic-challenge", ts: Date.now() },
            }),
          );
          socket.on("message", (data) => {
            const frame = JSON.parse(rawDataToString(data)) as RequestFrame;
            frames.push(frame);
            socket.send(
              JSON.stringify({
                type: "res",
                id: frame.id,
                ok: true,
                payload:
                  frame.method === "connect"
                    ? {
                        type: "hello-ok",
                        protocol: 4,
                        features: { methods: [], events: [] },
                        policy: { tickIntervalMs: 30_000 },
                      }
                    : {},
              }),
            );
          });
        });
        running = runConnect(["--target-file", targetFile, "--ephemeral"]);
        await Promise.race([
          connected.promise,
          running.then(() => {
            throw new Error("connect returned before the node connected");
          }),
        ]);
        expect(fixture.runtime.error).not.toHaveBeenCalled();
        expect(fixture.connected).toHaveBeenCalledWith(
          expect.objectContaining({
            url: `ws://127.0.0.1:${claim.port}`,
          }),
        );
        const connect = frames.find((frame) => frame.method === "connect");
        expect(connect?.params).toMatchObject({
          role: "node",
          device: { id: identity.deviceId },
        });
        expect(connect?.params).toHaveProperty("auth", {
          deviceToken: "synthetic-paired-node-token",
        });
        await expect(fs.stat(targetFile)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        stop();
        await running;
        fixture.connected.mockReset();
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await claim.release();
        process.exitCode = previousExitCode;
      }
    });
  });

  it.each([
    { name: "missing node token", token: false, wrongGateway: false, args: ["--ephemeral"] },
    { name: "different saved Gateway", token: true, wrongGateway: true, args: ["--ephemeral"] },
    { name: "manual node", token: true, wrongGateway: false, args: [] },
    { name: "manual session host", token: true, wrongGateway: false, args: ["--session-host"] },
    { name: "manual service", token: true, wrongGateway: false, args: ["--service"] },
  ])(
    "rejects an expired code for $name before changing the saved endpoint",
    async ({ token, wrongGateway, args }) => {
      await withOpenClawTestState({ label: "connect-expired-refusal" }, async () => {
        const gateway = { host: "127.0.0.1", port: 18789, tls: false, contextPath: "/paired" };
        await configureNodeHost({ gateway, fallbackDisplayName: "Refusal fixture" });
        const identity = loadOrCreateDeviceIdentity();
        if (token) {
          await storeDeviceAuthToken({
            deviceId: identity.deviceId,
            role: "node",
            token: "synthetic-paired-node-token",
          });
        }
        const saved = await loadNodeHostConfig();
        process.env.OPENCLAW_GATEWAY_TOKEN = "synthetic-unrelated-gateway-token";
        await runConnect([
          encodePairingSetupCode({
            url: `ws://127.0.0.1:18789/${wrongGateway ? "different" : "paired"}`,
            bootstrapToken: "synthetic-expired-bootstrap",
            expiresAtMs: 1,
          }),
          ...args,
        ]);

        expect(fixture.runtime.error).toHaveBeenCalledWith("Pairing setup code has expired.");
        expect(fixture.runtime.exit).toHaveBeenCalledWith(1);
        expect(fixture.connected).not.toHaveBeenCalled();
        expect(await loadNodeHostConfig()).toEqual(saved);
      });
    },
  );
});
