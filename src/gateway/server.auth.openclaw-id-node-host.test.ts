import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { parseUnixGatewayUrl } from "../../packages/gateway-client/src/unix-target.js";
import { WebSocketServer, type WebSocket } from "../../packages/gateway-client/src/websocket.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
  WORKER_PUBLIC_INGRESS_PATH,
  type WorkerConnectParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import {
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  isIrohEndpointKey,
  signStatement,
  ed25519SignerFromSeed,
  verifyDiscoveryRequest,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { buildWorld } from "../../packages/openclaw-id-protocol/src/testing/world.js";
import { writeConfigFile } from "../config/config.js";
import { loadOrCreateDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { createNodeHostGatewayCandidateConnection } from "../node-host/gateway-candidate-connection.js";
import { runNodeStreamTransport } from "../node-host/node-stream-transport.js";
import { withNodeWorkerTransferHttpRequest } from "../node-host/node-worker-transfer-http.js";
import type { NodeHostOpenClawIdTarget } from "../node-host/openclaw-id-target.js";
import { loadNodeTunnelKey, startNodeTunnelTransport } from "../node-host/openclaw-id-transport.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { createWorkerConnection } from "../worker/worker-connection.js";
import { startOpenClawIdIngressListener } from "./openclaw-id/ingress-listener.js";
import { loadIrohBinding } from "./openclaw-id/tunnel-child/addon.js";
import type { TunnelReadyMessage } from "./openclaw-id/tunnel-ipc.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./openclaw-id/tunnel-principal.js";
import { createTunnelSupervisor } from "./openclaw-id/tunnel-supervisor.js";
import { createGatewaySuiteHarness, installGatewayTestHooks, testState } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
// Like the tunnel-child suite, run native proof when its separately built addon is available.
let hasBinding = true;
try {
  loadIrohBinding();
} catch {
  hasBinding = false;
}
describe.skipIf(!hasBinding)("native OpenClaw ID node transport", () => {
  let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
  let ingress: Awaited<ReturnType<typeof startOpenClawIdIngressListener>>;
  let supervisor: ReturnType<typeof createTunnelSupervisor>;
  let transport: Awaited<ReturnType<typeof startNodeTunnelTransport>>;
  let dir: string;
  let discovery: Awaited<ReturnType<typeof reserveTestPortListener<http.Server>>>;
  const discoveryErrors: string[] = [];
  const terminal = vi.fn();
  let workerServer: WebSocketServer;
  const admission: WorkerConnectParams["admission"] = {
    environmentId: "tunnel-worker",
    sessionId: "session-1",
    runId: "run-1",
    ownerEpoch: 1,
    credential: "tunnel-test-worker-credential",
    rpcSetVersion: WORKER_RPC_SET_VERSION,
    handshake: {
      bundleHash: "a".repeat(64),
      openclawVersion: "2026.11.1",
      protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
    },
  };
  const transferPaths: string[] = [];
  const attachments: Array<{ path: string; metadata: string }> = [];
  const finiteReady = Promise.withResolvers<WebSocket>();
  const finiteClosed = Promise.withResolvers<Buffer>();

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-node-proof-"));
    const servers: http.Server[] = [];
    const spy = vi.spyOn(http.Server.prototype, "emit").mockImplementation(function (
      this: http.Server,
      event,
      ...args
    ) {
      if (event === "listening") {
        servers.push(this);
      }
      return EventEmitter.prototype.emit.call(this, event, ...args);
    });
    testState.gatewayAuth = undefined;
    await writeConfigFile({
      gateway: { auth: { mode: "token", token: "node-tunnel-proof-token" } },
    });
    harness = await createGatewaySuiteHarness();
    spy.mockRestore();
    const gatewayServer = servers.find((server) => {
      const address = server.address();
      return address && typeof address !== "string" && address.port === harness.port;
    });
    expect(gatewayServer).toBeDefined();
    const upstream = http.createServer((req, res) => {
      if (req.url?.startsWith("/__openclaw__/worker-")) {
        transferPaths.push(req.url);
        req.pipe(res);
      } else {
        gatewayServer!.emit("request", req, res);
      }
    });
    workerServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    upstream.on("upgrade", (req, socket, head) => {
      if (
        req.url?.startsWith("/node-desktop/attach?") ||
        req.url?.startsWith("/node-portal/attach?")
      ) {
        workerServer.handleUpgrade(req, socket, head, (peer) =>
          peer.once("message", (data) => {
            if (rawDataToString(data) === '{"finite":true}') {
              const chunks: Buffer[] = [];
              peer.pause();
              peer.on("message", (chunk) => chunks.push(Buffer.from(rawDataToString(chunk))));
              peer.once("close", () => finiteClosed.resolve(Buffer.concat(chunks)));
              finiteReady.resolve(peer);
              return;
            }
            attachments.push({ path: req.url!, metadata: rawDataToString(data) });
            peer.send(Buffer.from("attachment-response"));
          }),
        );
        return;
      }
      if (req.url !== WORKER_PUBLIC_INGRESS_PATH) {
        gatewayServer!.emit("upgrade", req, socket, head);
        return;
      }
      workerServer.handleUpgrade(req, socket, head, (peer) =>
        peer.once("message", (data) => {
          const frame = JSON.parse(rawDataToString(data));
          expect(frame.params.role).toBe("worker");
          peer.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "worker-hello-ok",
                environmentId: admission.environmentId,
                sessionId: admission.sessionId,
                ownerEpoch: admission.ownerEpoch,
                rpcSetVersion: admission.rpcSetVersion,
                protocolFeatures: admission.handshake.protocolFeatures,
                credentialExpiresAtMs: Date.now() + 60_000,
                policy: { heartbeatIntervalMs: 60_000, maxPayload: 25 * 1024 * 1024 },
              },
            }),
          );
        }),
      );
    });
    ingress = await startOpenClawIdIngressListener({
      socketPath: path.join(dir, "ingress.sock"),
      gatewayServer: () => upstream,
      log: { warn: () => {} },
    });
    const nodeSigner = await ed25519SignerFromSeed(loadNodeTunnelKey(dir));
    const peerKey = formatIrohEndpointKey(nodeSigner.publicKey);
    const principal = { kind: "owner" as const, peerKey };
    // Until the node-principal stack lands, use the existing test resolver; no Gateway auth changes.
    setOpenClawIdTunnelPrincipalResolver(async (key) => (key === peerKey ? principal : undefined));
    setOpenClawIdTunnelPrincipalLookup((key) => (key === peerKey ? principal : undefined));
    const entry = resolveRuntimeProcessEntrypointUrl("openclawIdTunnel");
    let resolveReady!: (ready: TunnelReadyMessage) => void;
    const readyPromise = new Promise<TunnelReadyMessage>((resolve) => {
      resolveReady = resolve;
    });
    supervisor = createTunnelSupervisor({
      launch: { entry, execArgv: resolveRuntimeWorkerArgv(entry).slice(0, -1) },
      startMessage: () => ({
        type: "start",
        relayUrl: "http://127.0.0.1:9/",
        keyPath: path.join(dir, "server", "key"),
        bindAddr: "127.0.0.1:0",
        ingress: { socketPath: ingress.socketPath, proxyToken: ingress.proxyToken },
        forwardedProto: "https",
      }),
      log: { info: () => {}, warn: () => {} },
      onReady: resolveReady,
    });
    supervisor.pushMembership(1, [peerKey]);
    supervisor.start();
    const ready = await readyPromise;
    if (!isIrohEndpointKey(ready.endpointKey)) {
      throw new Error("invalid child endpoint");
    }
    const world = await buildWorld();
    const binding = await signStatement(
      "ServerBinding",
      { ...world.binding.body, k_srv: ready.endpointKey },
      world.root,
    );
    const snapshot = await signStatement(
      "MembershipSnapshot",
      {
        claw_id: binding.body.claw_id,
        seq: 1,
        binding_seq: binding.body.binding_seq,
        owner_devices: [],
        owner_peer_keys: [],
        node_peer_keys: [peerKey],
        members: [],
        protocols: { statement: [1], descriptor: [1] },
        issued_at: Math.floor(Date.now() / 1000),
      },
      world.gateway.signer,
    );
    discovery = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        http.createServer((req, res) => {
          void (async () => {
            const signature = await verifyDiscoveryRequest(
              {
                method: req.method!,
                path: req.url!,
                body: new Uint8Array(),
              },
              String(req.headers["openclaw-signature"]),
              Math.floor(Date.now() / 1000),
            );
            expect(signature.ok).toBe(true);
            if (!signature.ok) {
              throw new Error("invalid node Discovery signature");
            }
            expect(signature.keyid).toBe(formatEd25519PublicKey(nodeSigner.publicKey));
            expect(req.url).toBe(`/v1/claws/${binding.body.claw_id}/node/descriptor`);
            expect(req.headers.authorization).toBeUndefined();
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                descriptor: {
                  v: 1,
                  claw_id: binding.body.claw_id,
                  transport: "iroh",
                  relay_url: "http://127.0.0.1:9/",
                  root_pub: world.rootPub,
                  binding,
                  published_at: Math.floor(Date.now() / 1000),
                },
                snapshot,
              }),
            );
          })().catch((error: unknown) => {
            discoveryErrors.push(String(error));
            res.writeHead(403).end("{}");
          });
        }),
    });
    let target: NodeHostOpenClawIdTarget = {
      hostname: binding.body.hostname,
      relayUrl: "http://127.0.0.1:9/",
      discoveryUrl: `http://127.0.0.1:${discovery.claim.port}`,
      pin: {
        claw_id: binding.body.claw_id,
        root_fp: await fingerprint(world.rootPub),
        binding_seq: 1,
      },
      evidence: { root_pub: world.rootPub, binding },
    };
    transport = await startNodeTunnelTransport({
      stateDir: dir,
      target,
      readTarget: async () => target,
      persistTarget: async (next) => {
        target = next;
      },
      directAddrs: ready.directAddrs.filter((addr) => addr.startsWith("127.0.0.1:")),
      onTerminal: terminal,
    });
  }, 30_000);

  afterAll(async () => {
    await transport?.close();
    discovery?.listener.closeAllConnections();
    await discovery?.releaseListener();
    await discovery?.claim.release();
    workerServer?.close();
    await supervisor?.stop();
    await ingress?.close();
    setOpenClawIdTunnelPrincipalLookup(undefined);
    setOpenClawIdTunnelPrincipalResolver(undefined);
    await harness?.close();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("node run's candidate client reaches node-role pairing over the real tunnel child", async () => {
    const gateway = { host: "unused.invalid" };
    const paused = vi.fn();
    let rejectConnect!: (error: Error) => void;
    const rejected = new Promise<Error>((resolve) => {
      rejectConnect = resolve;
    });
    const client = createNodeHostGatewayCandidateConnection({
      candidates: [gateway],
      candidateUrls: new Map([[gateway, transport.url]]),
      clientOptions: {
        clientName: "node-host",
        clientVersion: "2026.11.1",
        mode: "node",
        role: "node",
        scopes: [],
        caps: [],
        commands: [],
        deviceIdentity: await loadOrCreateDeviceIdentityAsync(),
        hostDeps: { loadDeviceAuthToken: () => null, storeDeviceAuthToken: () => {} },
      },
      onEvent: () => {},
      onHelloOk: () => {},
      onConnectError: rejectConnect,
      onReconnectPaused: paused,
      onClose: () => {},
      onWinningCandidate: () => {},
    });
    client.start();
    try {
      expect((await rejected).message).toMatch(/pairing/i);
      const label = transport.formatDiagnostic(transport.url);
      expect(label).toMatch(/^.+ via OpenClaw ID \(direct\)$/);
      const socketPath = parseUnixGatewayUrl(transport.url)!.socketPath;
      expect(transport.formatDiagnostic(`connect ENOENT ${socketPath}`)).toBe(
        `connect ENOENT ${label}`,
      );
      expect(transport.formatDiagnostic("pairing required")).toBe("pairing required");
      expect(
        (await listDevicePairing()).pending.some(
          (entry) => entry.role === "node" || entry.roles?.includes("node"),
        ),
      ).toBe(true);
      expect(paused).not.toHaveBeenCalled();
      expect(terminal).not.toHaveBeenCalled();
    } finally {
      await client.stop();
    }
  });

  test("worker admission uses the same private bridge", async () => {
    const unix = parseUnixGatewayUrl(transport.url)!;
    const worker = createWorkerConnection({
      endpoint: { kind: "unix", socketPath: unix.socketPath, path: WORKER_PUBLIC_INGRESS_PATH },
      connectParams: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "openclaw-worker", version: "2026.11.1", platform: "linux", mode: "worker" },
        role: "worker",
        admission,
      },
    });
    try {
      expect((await worker.start()).environmentId).toBe("tunnel-worker");
    } finally {
      await worker.stop();
    }
  });

  test.each(["desktop", "portal"])(
    "%s attachment streams use the authenticated tunnel",
    async (kind) => {
      const controller = new AbortController();
      const received = Promise.withResolvers<Buffer>();
      const target = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          received.resolve(Buffer.from(chunk));
          callback();
        },
      });
      const attachPath = `/node-${kind}/attach?ticket=${"1".repeat(48)}`;
      const running = runNodeStreamTransport({
        gatewayUrl: transport.url,
        attachPath,
        expectedAttachPath: `/node-${kind}/attach`,
        target: { stream: target },
        metadata: { ok: true },
        streamName: kind,
        signal: controller.signal,
      });
      try {
        expect(await Promise.race([received.promise, running])).toEqual(
          Buffer.from("attachment-response"),
        );
        expect(attachments.at(-1)).toEqual({ path: attachPath, metadata: '{"ok":true}' });
      } finally {
        controller.abort();
        await running;
      }
    },
  );

  test("finite portal payload drains through the native tunnel before graceful close", async () => {
    const controller = new AbortController();
    const body = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
    let offset = 0;
    const target = new Duplex({
      read() {
        if (offset === body.length) {
          this.push(null);
          this.end();
        } else {
          const next = body.subarray(offset, offset + 64 * 1024);
          offset += next.length;
          this.push(next);
        }
      },
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const running = runNodeStreamTransport({
      gatewayUrl: transport.url,
      attachPath: `/node-portal/attach?ticket=${"2".repeat(48)}`,
      expectedAttachPath: "/node-portal/attach",
      target: { stream: target },
      metadata: { finite: true },
      streamName: "portal",
      signal: controller.signal,
    });
    const peer = await finiteReady.promise;
    try {
      await running;
      peer.resume();
      const received = await finiteClosed.promise;
      expect(received.length).toBe(body.length);
      expect(received.equals(body)).toBe(true);
    } finally {
      peer.resume();
      controller.abort();
      await running;
    }
  });

  test("both streaming transfer routes use the same private bridge", async () => {
    const body = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
    for (const routePath of [
      "/__openclaw__/worker-bundle/v1/proof",
      "/__openclaw__/worker-transfer/v1/proof",
    ]) {
      const received = await withNodeWorkerTransferHttpRequest(
        {
          gatewayUrl: transport.url,
          routePath,
          method: "POST",
          token: "fixture-transfer-token",
          headers: { "content-length": String(body.length) },
          writeBody: async (write) => {
            await write(body);
          },
        },
        async (res) => {
          const chunks: Buffer[] = [];
          for await (const chunk of res) {
            chunks.push(Buffer.from(chunk));
          }
          return Buffer.concat(chunks);
        },
      );
      expect(received).toEqual(body);
    }
    expect(transferPaths).toEqual([
      "/__openclaw__/worker-bundle/v1/proof",
      "/__openclaw__/worker-transfer/v1/proof",
    ]);
  });

  test("HTTP health and private key permissions", async () => {
    const status = await withNodeWorkerTransferHttpRequest(
      { gatewayUrl: transport.url, routePath: "/healthz", method: "GET", token: "unused" },
      async (res) => {
        for await (const _ of res) {
          /* consume the streaming body */
        }
        return res.statusCode;
      },
    );
    expect(status).toBe(200);
    expect(discoveryErrors).toEqual([]);
    expect((await fs.stat(path.join(dir, "node-openclaw-id", "endpoint.key"))).mode & 0o777).toBe(
      0o600,
    );
  });
});
