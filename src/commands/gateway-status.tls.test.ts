import { X509Certificate } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Socket } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.test-support.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import type { SshTunnel } from "../infra/ssh-tunnel.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { gatewayStatusCommand } from "./gateway-status.js";

const boundary = vi.hoisted(() => ({
  config: vi.fn<typeof import("../config/config.js").readBestEffortConfig>(),
  forward: vi.fn<typeof import("../infra/ssh-tunnel.js").startSshPortForward>(),
}));
// mock-isolation: Supply synthetic command input without reading operator configuration.
vi.mock("../config/config.js", async (original) => ({
  ...(await original<typeof import("../config/config.js")>()),
  readBestEffortConfig: boundary.config,
}));
// mock-isolation: Replace OpenSSH with a real TCP forwarder; TLS and Gateway clients stay real.
vi.mock("../infra/ssh-tunnel.js", async (original) => ({
  ...(await original<typeof import("../infra/ssh-tunnel.js")>()),
  startSshPortForward: boundary.forward,
}));
// mock-isolation: Avoid ambient SSH configuration and network discovery.
vi.mock("../infra/ssh-config.js", () => ({ resolveSshConfig: async () => null }));
// mock-isolation: Only the explicitly configured diagnostic targets participate.
vi.mock("../infra/bonjour-discovery.js", () => ({ discoverGatewayBeacons: async () => [] }));

async function startGateway(tls: boolean) {
  const listener = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      tls
        ? createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM })
        : createHttpServer(),
  });
  const sockets = new Set<Socket>();
  listener.listener.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const paths: string[] = [];
  const wss = new WebSocketServer({ server: listener.listener });
  wss.on("connection", (ws, request) => {
    paths.push(request.url ?? "");
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (raw) => {
      const frame = parseMinimalGatewayRequestFrame(raw);
      if (frame.id) {
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          frame.method === "connect"
            ? buildMinimalGatewayHelloOkPayload({
                auth: { role: "operator", scopes: ["operator.read"] },
              })
            : frame.method === "system-presence"
              ? []
              : {},
        );
      }
    });
  });
  return {
    port: listener.claim.port,
    paths,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeMinimalGatewayServer(wss);
      await listener.releaseListener();
      await listener.claim.release();
    },
  };
}

let tlsGateway: Awaited<ReturnType<typeof startGateway>>;
let plainGateway: Awaited<ReturnType<typeof startGateway>>;
beforeAll(async () => {
  tlsGateway = await startGateway(true);
  plainGateway = await startGateway(false);
});
afterAll(async () => {
  await tlsGateway?.close();
  await plainGateway?.close();
});

it.each([
  { name: "matching pin", trust: "pin", ok: true },
  { name: "SSH-prefixed alias", trust: "pin", prefixed: true, ok: true },
  { name: "wrong pin", trust: "wrong", ok: false, error: /fingerprint mismatch/i },
  { name: "untrusted CA", trust: "ca", ok: false, error: /certificate|self.signed/i },
  { name: "different SSH alias", trust: "pin", ssh: "other", excluded: true, ok: true },
  { name: "port override", trust: "pin", ssh: "fixture", override: true, excluded: true, ok: true },
  { name: "direct transport", trust: "pin", direct: true, excluded: true, ok: true },
])("probes TLS through SSH with $name", async (scenario) => {
  await withTestDir({ prefix: "gateway-ssh-tls-" }, async (stateDir) => {
    const gateway = scenario.excluded ? plainGateway : tlsGateway;
    const tunnels: SshTunnel[] = [];
    boundary.forward.mockImplementation(async () => {
      const sockets = new Set<Socket>();
      const forward = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((incoming) => {
            const outgoing = connect(gateway.port, "127.0.0.1");
            for (const socket of [incoming, outgoing]) {
              sockets.add(socket);
              socket.once("close", () => sockets.delete(socket));
              socket.on("error", () => {
                incoming.destroy();
                outgoing.destroy();
              });
            }
            incoming.pipe(outgoing).pipe(incoming);
          }),
      });
      const closed = Promise.withResolvers<void>();
      let stopped: Promise<void> | undefined;
      const tunnel: SshTunnel = {
        localPort: forward.claim.port,
        pid: null,
        isActive: () => stopped === undefined,
        closed: closed.promise,
        stop: () =>
          (stopped ??= (async () => {
            for (const socket of sockets) {
              socket.destroy();
            }
            await forward.releaseListener();
            await forward.claim.release();
            closed.resolve();
          })()),
      };
      tunnels.push(tunnel);
      return tunnel;
    });
    boundary.config.mockResolvedValue({
      gateway: {
        mode: "remote",
        port: gateway.port,
        remote: {
          url: `wss://localhost:${tlsGateway.port}/gateway?probe=1`,
          remotePort: tlsGateway.port,
          sshTarget: scenario.prefixed ? "ssh fixture" : "fixture",
          transport: scenario.direct ? "direct" : undefined,
          tlsFingerprint:
            scenario.trust === "ca"
              ? undefined
              : scenario.trust === "wrong"
                ? "00".repeat(32)
                : new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
          token: "synthetic-ssh-probe-token",
        },
      },
    });
    const logs: string[] = [];
    const before = gateway.paths.length;
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_PORT: undefined }, () =>
        gatewayStatusCommand(
          {
            json: true,
            timeout: "3000",
            ssh: scenario.ssh,
            port: scenario.override ? String(plainGateway.port) : undefined,
          },
          { log: (value) => logs.push(String(value)), error: vi.fn(), exit: vi.fn() },
        ),
      );
      const output = JSON.parse(logs.join("\n")) as {
        targets: { kind: string; connect: { rpcOk: boolean; error: string | null } }[];
      };
      const result = output.targets.find((target) => target.kind === "sshTunnel")?.connect;
      expect(result?.rpcOk, result?.error ?? undefined).toBe(scenario.ok);
      if (scenario.error) {
        expect(result?.error).toMatch(scenario.error);
        expect(gateway.paths.slice(before)).toEqual([]);
      } else {
        expect(gateway.paths.slice(before)).toContain(scenario.excluded ? "/" : "/gateway?probe=1");
      }
      expect(tunnels.length).toBeGreaterThan(0);
      expect(tunnels.every((tunnel) => !tunnel.isActive())).toBe(true);
    } finally {
      await Promise.all(tunnels.map((tunnel) => tunnel.stop()));
    }
  });
});
