import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { BindOptions, Endpoint } from "../../crates/openclaw-iroh-node/index.js";
import {
  ed25519SignerFromSeed,
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  signStatement,
  verifyDiscoveryRequest,
  type ClawDescriptor,
  type SignedStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { buildWorld } from "../../packages/openclaw-id-protocol/src/testing/world.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import type { NodeHostOpenClawIdTarget } from "./openclaw-id-target.js";
import { startNodeTunnelTransport } from "./openclaw-id-transport.js";

const native = vi.hoisted(() => ({ bind: vi.fn<(options: BindOptions) => Promise<Endpoint>>() }));
vi.mock("../gateway/openclaw-id/tunnel-child/addon.js", async (original) => ({
  ...(await original<typeof import("../gateway/openclaw-id/tunnel-child/addon.js")>()),
  loadIrohBinding: () => ({ bind: native.bind }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unixTest = test.skipIf(process.platform === "win32");
const world = await buildWorld();
const nodeSeed = new Uint8Array(32).fill(23);
const nodeSigner = await ed25519SignerFromSeed(nodeSeed);
const nodeKey = formatIrohEndpointKey(nodeSigner.publicKey);
const rootFingerprint = await fingerprint(world.rootPub);
const transports: Awaited<ReturnType<typeof startNodeTunnelTransport>>[] = [];
const requests = new Set<http.ClientRequest>();
let server: Awaited<ReturnType<typeof reserveTestPortListener<http.Server>>>;
let origin: string;
let stateDir: string;
let saved: NodeHostOpenClawIdTarget;
let served: { descriptor: ClawDescriptor; snapshot?: unknown };
let signatureErrors: string[];
let reads: number;
let persistenceError: Error | undefined;
let terminal: ReturnType<typeof vi.fn<(error: Error) => void>>;
let connect: ReturnType<typeof vi.fn<Endpoint["connect"]>>;

async function responseFor(
  binding = world.binding,
  overrides: Partial<SignedStatement<"MembershipSnapshot">["body"]> = {},
  signer = world.gateway.signer,
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    descriptor: {
      v: 1 as const,
      claw_id: binding.body.claw_id,
      transport: "iroh" as const,
      relay_url: "https://relay.example/",
      root_pub: world.rootPub,
      binding,
      published_at: now,
    },
    snapshot: await signStatement(
      "MembershipSnapshot",
      {
        claw_id: binding.body.claw_id,
        seq: binding.body.binding_seq,
        binding_seq: binding.body.binding_seq,
        owner_devices: [],
        owner_peer_keys: [],
        node_peer_keys: [nodeKey],
        members: [],
        protocols: { statement: [1], descriptor: [1] },
        issued_at: now,
        ...overrides,
      },
      signer,
    ),
  };
}

beforeAll(async () => {
  server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      http.createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk));
          }
          const signature = await verifyDiscoveryRequest(
            { method: req.method!, path: req.url!, body: Buffer.concat(chunks) },
            String(req.headers["openclaw-signature"]),
            Math.floor(Date.now() / 1000),
          );
          reads++;
          if (
            req.method !== "GET" ||
            req.url !== `/v1/claws/${world.binding.body.claw_id}/node/descriptor` ||
            req.headers.authorization ||
            !signature.ok ||
            signature.keyid !== formatEd25519PublicKey(nodeSigner.publicKey)
          ) {
            signatureErrors.push("invalid accountless node descriptor request");
            res.writeHead(403).end(JSON.stringify({ error: { code: "forbidden" } }));
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(served));
        })().catch((error: unknown) => {
          signatureErrors.push(String(error));
          res.writeHead(500).end("{}");
        });
      }),
  });
  origin = `http://127.0.0.1:${server.claim.port}`;
});

beforeEach(async () => {
  terminal = vi.fn<(error: Error) => void>();
  reads = 0;
  signatureErrors = [];
  persistenceError = undefined;
  stateDir = tempDirs.make("openclaw-node-tunnel-");
  const keyDir = path.join(stateDir, "node-openclaw-id");
  await fs.mkdir(keyDir, { mode: 0o700 });
  await fs.writeFile(path.join(keyDir, "endpoint.key"), nodeSeed, { mode: 0o600 });
  served = await responseFor();
  saved = {
    hostname: world.binding.body.hostname,
    pin: {
      claw_id: world.binding.body.claw_id,
      root_fp: rootFingerprint,
      binding_seq: 1,
      k_gw: world.gateway.pub,
    },
    evidence: { root_pub: world.rootPub, binding: world.binding },
    relayUrl: "https://relay.example/",
    discoveryUrl: origin,
  };
  connect = vi.fn<Endpoint["connect"]>(async () => {
    throw new Error("fixture stops after the authenticated destination is selected");
  });
  const endpoint: Endpoint = {
    id: () => nodeKey.slice(5),
    boundSockets: () => [],
    online: async () => {},
    homeRelayStatus: () => [],
    watchHomeRelay: async () => ({ next: async () => null }),
    accept: async () => null,
    connect,
    close: async () => {},
  };
  native.bind.mockReset().mockResolvedValue(endpoint);
});

afterEach(async () => {
  for (const request of requests) {
    request.destroy();
  }
  requests.clear();
  for (const tunnel of transports.splice(0)) {
    await tunnel.close();
  }
});

afterAll(async () => {
  server.listener.closeAllConnections();
  await server.releaseListener();
  await server.claim.release();
});

async function start() {
  // Extra callbacks remain a valid variable argument on the vulnerable base, which ignores them.
  const options = {
    target: saved,
    stateDir,
    readTarget: async () => structuredClone(saved),
    persistTarget: async (next: NodeHostOpenClawIdTarget) => {
      if (persistenceError) {
        throw persistenceError;
      }
      saved = structuredClone(next);
    },
    onTerminal: terminal,
  };
  const tunnel = await startNodeTunnelTransport(options);
  transports.push(tunnel);
  return tunnel;
}

async function requestThrough(tunnel: Awaited<ReturnType<typeof start>>) {
  const socketPath = tunnel.url.slice("ws+unix:".length, -":/".length);
  return await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get({ socketPath, path: "/healthz", agent: false }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
      response.once("error", reject);
    });
    requests.add(request);
    request.once("close", () => requests.delete(request));
    request.once("error", reject);
  });
}

unixTest(
  "refreshes a saved server key before dialing and retains rollback evidence across restart",
  async () => {
    const tunnel = await start();
    const rotated = await signStatement(
      "ServerBinding",
      { ...world.binding.body, binding_seq: 2, k_srv: world.mallory.peer },
      world.root,
    );
    served = await responseFor(rotated, { seq: 3 });
    expect(await requestThrough(tunnel)).toBe(502);
    expect(connect.mock.calls.map(([key]) => key)).toEqual([world.mallory.peer.slice(5)]);
    expect(saved.pin.binding_seq).toBe(2);
    expect(saved.freshness?.snapshot).toMatchObject({ seq: 3, binding_seq: 2 });
    expect(signatureErrors).toEqual([]);
    expect(reads).toBeGreaterThan(0);

    await tunnel.close();
    transports.splice(transports.indexOf(tunnel), 1);
    const restarted = await start();
    served = await responseFor();
    expect(await requestThrough(restarted)).toBe(502);
    served = await responseFor(rotated, { seq: 2 });
    expect(await requestThrough(restarted)).toBe(502);
    expect(connect.mock.calls.map(([key]) => key)).toEqual([world.mallory.peer.slice(5)]);
    expect(saved.pin.binding_seq).toBe(2);
    expect(saved.freshness?.snapshot?.seq).toBe(3);
    expect(signatureErrors).toEqual([]);
  },
);

unixTest.each(["missing", "stale", "invalid", "future", "node omitted"] as const)(
  "refuses %s membership evidence before opening a tunnel",
  async (kind) => {
    const tunnel = await start();
    if (kind === "missing") {
      served = { descriptor: served.descriptor };
    } else {
      const overrides =
        kind === "stale"
          ? { issued_at: 1 }
          : kind === "future"
            ? { issued_at: Math.floor(Date.now() / 1000) + 3600 }
            : kind === "node omitted"
              ? { node_peer_keys: [] }
              : {};
      served = await responseFor(
        world.binding,
        overrides,
        kind === "invalid" ? world.mallory.signer : world.gateway.signer,
      );
    }
    expect(await requestThrough(tunnel)).toBe(502);
    expect(connect).not.toHaveBeenCalled();
    if (kind === "node omitted") {
      expect(terminal).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("re-join") }),
      );
    }
    expect(reads).toBeGreaterThan(0);
    expect(signatureErrors).toEqual([]);
  },
);

unixTest("does not dial when verified rotation cannot be persisted", async () => {
  const tunnel = await start();
  const rotated = await signStatement(
    "ServerBinding",
    { ...world.binding.body, binding_seq: 2, k_srv: world.mallory.peer },
    world.root,
  );
  served = await responseFor(rotated);
  persistenceError = new Error("fixture config write refused");
  expect(await requestThrough(tunnel)).toBe(502);
  expect(connect).not.toHaveBeenCalled();
  expect(saved.pin.binding_seq).toBe(1);
  persistenceError = undefined;
  served = await responseFor();
  expect(await requestThrough(tunnel)).toBe(502);
  expect(connect).not.toHaveBeenCalled();
  expect(signatureErrors).toEqual([]);
});

unixTest(
  "retains signed evidence of a newer binding even when Discovery withholds that binding",
  async () => {
    const tunnel = await start();
    served = await responseFor(world.binding, { seq: 4, binding_seq: 2 });
    expect(await requestThrough(tunnel)).toBe(502);
    expect(saved.freshness?.snapshot).toMatchObject({ seq: 4, binding_seq: 2 });
    served = await responseFor();
    expect(await requestThrough(tunnel)).toBe(502);
    expect(connect).not.toHaveBeenCalled();
    expect(saved.freshness?.snapshot?.binding_seq).toBe(2);
  },
);
