import { X509Certificate } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer, type Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "../../../packages/gateway-client/src/websocket.test-support.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../../test/helpers/tls-fixture.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import type { SshTunnel } from "../../infra/ssh-tunnel.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { gatewayStatusCommand } from "../gateway-status.js";

const boundary = vi.hoisted(() => ({
  start: vi.fn<() => Promise<SshTunnel>>(),
  config: vi.fn<typeof import("../../config/config.js").readBestEffortConfig>(),
}));
// mock-isolation: Replace the external SSH process with an owned TCP forwarder for real TLS traffic.
vi.mock("../../infra/ssh-tunnel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/ssh-tunnel.js")>()),
  startSshPortForward: boundary.start,
}));
// mock-isolation: Select synthetic config at the real public command input boundary.
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readBestEffortConfig: boundary.config,
}));
// mock-isolation: Exclude external SSH alias lookup; preserve the real route parser.
vi.mock("../../infra/ssh-config.js", () => ({ resolveSshConfig: async () => null }));
// mock-isolation: Disable ambient network discovery to keep the configured SSH route isolated.
vi.mock("../../infra/bonjour-discovery.js", () => ({ discoverGatewayBeacons: async () => [] }));

function readSshProbe(runtimeLogs: string[]) {
  const payload: unknown = JSON.parse(runtimeLogs.join("\n"));
  if (
    !payload ||
    typeof payload !== "object" ||
    !("targets" in payload) ||
    !Array.isArray(payload.targets)
  ) {
    throw new Error("Expected public gateway probe targets");
  }
  const target: unknown = payload.targets.find(
    (entry: unknown) =>
      entry !== null && typeof entry === "object" && "kind" in entry && entry.kind === "sshTunnel",
  );
  if (
    !target ||
    typeof target !== "object" ||
    !("connect" in target) ||
    !target.connect ||
    typeof target.connect !== "object" ||
    !("rpcOk" in target.connect) ||
    !("error" in target.connect)
  ) {
    throw new Error("Expected SSH diagnostic connection result");
  }
  return target.connect;
}

it.each(["fixture", "ssh fixture"])(
  "probes configured TLS through a real byte-forwarding tunnel and rejects a wrong pin (SSH target=%s)",
  async (sshTarget) => {
    await withTestDir({ prefix: "ssh-probe-tls-" }, async (stateDir) => {
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_PORT: undefined },
        async () => {
          const sockets = new Set<Socket>();
          const track = (socket: Socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            return socket;
          };
          const tls = await reserveTestPortListener({
            offsets: [0],
            createListener: () =>
              createHttpsServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM }),
          });
          tls.listener.on("connection", track);
          const wss = new WebSocketServer({ server: tls.listener });
          const requests: string[] = [];
          tls.listener.on("request", (request) => {
            requests.push(request.url ?? "");
          });
          tls.listener.on("upgrade", (request) => {
            requests.push(request.url ?? "");
          });
          wss.on("connection", (ws) => {
            sendMinimalGatewayConnectChallenge(ws);
            ws.on("message", (raw) => {
              const frame = parseMinimalGatewayRequestFrame(raw);
              if (!frame.id) {
                return;
              }
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
            });
          });
          const pin = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
          try {
            for (const fingerprint of [pin, "00".repeat(32)]) {
              const forwarded = new Set<Socket>();
              const forward = await reserveTestPortListener({
                offsets: [0],
                createListener: () =>
                  createServer((incoming) => {
                    const outgoing = connect(tls.claim.port, "127.0.0.1");
                    for (const socket of [incoming, outgoing]) {
                      forwarded.add(socket);
                      socket.once("close", () => forwarded.delete(socket));
                      socket.on("error", () => {
                        incoming.destroy();
                        outgoing.destroy();
                      });
                    }
                    incoming.pipe(outgoing).pipe(incoming);
                  }),
              });
              let active = true;
              let settleClosed!: () => void;
              const closed = new Promise<void>((resolve) => {
                settleClosed = resolve;
              });
              let stopped: Promise<void> | undefined;
              const stop = () =>
                (stopped ??= (async () => {
                  active = false;
                  for (const socket of forwarded) {
                    socket.destroy();
                  }
                  await forward.releaseListener();
                  await forward.claim.release();
                  settleClosed();
                })());
              // Only replace the external SSH process boundary. The separate configRemote
              // sibling is disabled so its connection cannot satisfy this route's oracle.
              boundary.start.mockReset();
              boundary.start.mockResolvedValueOnce({
                localPort: forward.claim.port,
                pid: null,
                isActive: () => active,
                closed,
                stop,
              });
              boundary.start.mockRejectedValue(
                new Error("separate configured-remote probe disabled in fixture"),
              );
              const url = `wss://localhost:${tls.claim.port}/gateway?probe=1`;
              const before = requests.length;
              try {
                boundary.config.mockResolvedValueOnce({
                  gateway: {
                    mode: "remote",
                    // The public command's local-loopback sibling must also stay on
                    // this fixture's owned listener, never an ambient Gateway port.
                    port: tls.claim.port,
                    remote: {
                      url,
                      remotePort: tls.claim.port,
                      sshTarget,
                      tlsFingerprint: fingerprint,
                      token: "synthetic-token",
                    },
                  },
                });
                const runtimeLogs: string[] = [];
                const runtimeErrors: string[] = [];
                const runtimeExits: number[] = [];
                const runtime: RuntimeEnv = {
                  log: (message) => {
                    runtimeLogs.push(String(message));
                  },
                  error: (message) => {
                    runtimeErrors.push(String(message));
                  },
                  exit: (code) => {
                    runtimeExits.push(code);
                  },
                };
                await gatewayStatusCommand({ timeout: "2000", json: true }, runtime);
                expect(runtimeLogs).toHaveLength(1);
                expect(runtimeErrors).toEqual([]);
                const probe = readSshProbe(runtimeLogs);
                console.log(
                  JSON.stringify({
                    sshTarget,
                    matchingPin: fingerprint === pin,
                    ok: probe.rpcOk,
                    error: probe.error,
                    requests: requests.slice(before),
                    tunnelClosed: !active,
                  }),
                );
                expect(runtimeExits).toEqual(fingerprint === pin ? [] : [1]);
                if (fingerprint === pin) {
                  expect(probe.rpcOk).toBe(true);
                  expect(requests.slice(before)).toEqual(["/gateway?probe=1"]);
                } else {
                  expect(probe.rpcOk).toBe(false);
                  expect(probe.error).toMatch(/fingerprint/i);
                  expect(requests).toHaveLength(before);
                }
                expect(active).toBe(false);
              } finally {
                await stop();
              }
            }
          } finally {
            for (const socket of sockets) {
              socket.destroy();
            }
            await closeMinimalGatewayServer(wss);
            await tls.releaseListener();
            await tls.claim.release();
          }
        },
      );
    });
  },
);
