import { randomBytes } from "node:crypto";
import { on, once } from "node:events";
import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import { constants as zlibConstants, deflateRawSync } from "node:zlib";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientOptions } from "ws";
import {
  WebSocket,
  WebSocketServer,
} from "../../../../packages/gateway-client/src/websocket.test-support.js";
import { writeConfigFile } from "../../../config/config.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { acquireTestPortBlock } from "../../../test-utils/port-claims.js";
import { createPluginGatewayMethodDescriptor } from "../../methods/descriptor.js";
import { MAX_PAYLOAD_BYTES } from "../../payload-limits.js";
import { SerializedJsonArray } from "../../serialized-json.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../../server-constants.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  startTestGatewayServer,
  trackConnectChallengeNonce,
} from "../../test-helpers.js";
import {
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "../../test-helpers.plugin-registry.js";
import { GATEWAY_PER_MESSAGE_DEFLATE, registerDeflatedSegment } from "../ws-compression.js";

installGatewayTestHooks({ scope: "suite" });

async function openOperatorSocket(
  open: (options?: ClientOptions) => WebSocket,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  const socket = open({ headers });
  trackConnectChallengeNonce(socket);
  await once(socket, "open");
  try {
    await connectOk(socket, { token, prePairDevice: headers !== undefined });
    return socket;
  } catch (error) {
    socket.terminate();
    throw error;
  }
}

async function sendTraceRequest(socket: WebSocket, id: string): Promise<{ ok: boolean }> {
  const response = onceMessage<{ type: "res"; id: string; ok: boolean }>(
    socket,
    (value) => value.type === "res" && value.id === id,
  );
  socket.send(rpc(id));
  return await response;
}

const token = "gateway-request-start-test-token";

async function withServer(
  run: (fixture: {
    port: number;
    capture: ReturnType<typeof captureGatewayConnection>;
    open: (options?: ClientOptions) => WebSocket;
  }) => Promise<void>,
) {
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const server = await startTestGatewayServer(portClaim, {
    auth: { mode: "token", token },
    bind: "loopback",
    controlUiEnabled: false,
  });
  const capture = captureGatewayConnection(portClaim.port);
  const sockets: WebSocket[] = [];
  try {
    await run({
      port: portClaim.port,
      capture,
      open: (options) => {
        const socket = new WebSocket(`ws://127.0.0.1:${portClaim.port}`, options);
        sockets.push(socket);
        return socket;
      },
    });
  } finally {
    for (const socket of sockets) {
      socket.terminate();
    }
    try {
      await server.close();
    } finally {
      capture.restore();
      resetTestPluginRegistry();
    }
  }
}

function registerMethods(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
  names = Object.keys(registry.gatewayHandlers),
) {
  for (const name of names) {
    const handler = registry.gatewayHandlers[name];
    if (!handler) {
      throw new Error(`Missing fixture handler: ${name}`);
    }
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "request-start-proof",
        name,
        handler,
      }),
    );
  }
}

function rpc(id: string, method = "test.trace", params = {}) {
  return JSON.stringify({ type: "req", id, method, params });
}

function captureGatewayConnection(port: number) {
  let connection: { socket: WebSocket; stream: IncomingMessage["socket"] } | undefined;
  const emitter: {
    emit: (this: WebSocketServer, event: string | symbol, ...args: unknown[]) => boolean;
  } = WebSocketServer.prototype;
  const originalEmit = emitter.emit;
  const observer = vi.spyOn(WebSocketServer.prototype, "emit").mockImplementation(function (
    this: WebSocketServer,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "connection") {
      const [socket, request] = args as [WebSocket, IncomingMessage];
      if (request.socket.localPort === port) {
        connection = { socket, stream: request.socket };
      }
    }
    return originalEmit.call(this, event, ...args);
  });
  return {
    get: () => {
      if (!connection) {
        throw new Error("expected the real gateway connection for the test port");
      }
      return connection;
    },
    restore: () => observer.mockRestore(),
  };
}

function maskedFrame(opcode: 0x81 | 0x88 | 0x89 | 0x8a, text: string, compressed = false): Buffer {
  const payload = compressed
    ? deflateRawSync(Buffer.from(text), { finishFlush: zlibConstants.Z_SYNC_FLUSH }).subarray(0, -4)
    : Buffer.from(text);
  if (payload.length >= 126) {
    throw new Error("fixture requires a short masked WebSocket frame");
  }
  const mask = Buffer.from([1, 2, 3, 4]);
  for (let index = 0; index < payload.length; index++) {
    payload[index] = payload[index]! ^ mask[index % mask.length]!;
  }
  return Buffer.concat([
    Buffer.from([opcode | (compressed ? 0x40 : 0), 0x80 | payload.length]),
    mask,
    payload,
  ]);
}

function injectReceiveChunk(stream: IncomingMessage["socket"], frames: Buffer[]) {
  // Exercise the installed receiver through one actual upgraded stream chunk,
  // independent of how TCP splits writes; never set private receiver policy here.
  stream.pause();
  stream.unshift(Buffer.concat(frames));
  stream.resume();
}

describe("authenticated operator request starts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a coalesced authenticated operator burst before an immediate while completions overlap", async () => {
    await writeConfigFile({ gateway: { trustedProxies: ["127.0.0.1"] } });
    const ids = Array.from({ length: 33 }, (_, index) => `burst-${index}`);
    const starts: string[] = [];
    const completed: string[] = [];
    const held = createDeferredCore();
    const observedAtYield = createDeferredCore<string[]>();
    let sentinel: ReturnType<typeof setImmediate> | undefined;
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.trace"] = async ({ req, respond }) => {
      if (req.id === "warmup") {
        respond(true);
        return;
      }
      starts.push(req.id);
      if (starts.length === 1) {
        sentinel = setImmediate(() => observedAtYield.resolve([...starts]));
      }
      if (req.id !== ids.at(-1)) {
        await held.promise;
      }
      completed.push(req.id);
      respond(true);
    };
    registerMethods(registry);
    setTestPluginRegistry(registry);
    let restoreClock: (() => void) | undefined;
    let allResponses: Promise<unknown> | undefined;
    await withServer(async ({ capture, open }) => {
      try {
        const ws = await openOperatorSocket(open, {
          "x-forwarded-for": "198.51.100.10",
        });
        await expect(sendTraceRequest(ws, "warmup")).resolves.toMatchObject({ ok: true });
        const { stream } = capture.get();
        expect(ws.extensions).toContain("permessage-deflate");
        // This case isolates cheap-start batching. Other owner cases advance the
        // work clock to prove the elapsed-work fairness boundary independently.
        const now = performance.now();
        const clock = vi.spyOn(performance, "now").mockReturnValue(now);
        restoreClock = () => clock.mockRestore();
        const responsesById = new Map<string, boolean>();
        allResponses = onceMessage(ws, (value) => {
          if (value.type === "res" && typeof value.id === "string" && ids.includes(value.id)) {
            responsesById.set(value.id, value.ok === true);
          }
          return responsesById.size === ids.length;
        });
        // Observe failures immediately; cleanup still joins the response promise.
        void allResponses.catch(() => {});
        const markerResponse = onceMessage(
          ws,
          (value) => value.type === "res" && value.id === ids.at(-1),
        );
        // Chrome also compresses small requests when the extension is negotiated.
        injectReceiveChunk(
          stream,
          ids.map((id) => maskedFrame(0x81, rpc(id), true)),
        );

        await expect(markerResponse).resolves.toMatchObject({ ok: true });
        expect(starts).toEqual(ids);
        expect(completed).toEqual([ids.at(-1)]);
        expect(await observedAtYield.promise).toEqual(ids);
        held.resolve();
        await allResponses;
        expect(responsesById).toEqual(new Map(ids.map((id) => [id, true])));
      } finally {
        held.resolve();
        await allResponses?.catch(() => {});
        clearImmediate(sentinel);
        restoreClock?.();
      }
    });
  });

  it("delivers operator control frames while ordinary request completions overlap", async () => {
    const held = createDeferredCore();
    let completed = false;
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.trace"] = async ({ req, respond }) => {
      if (req.id === "held") {
        await held.promise;
        completed = true;
      }
      respond(true);
    };
    registerMethods(registry);
    setTestPluginRegistry(registry);
    await withServer(async ({ capture, open }) => {
      const ws = await openOperatorSocket(open);
      await sendTraceRequest(ws, "warmup");
      const { socket, stream } = capture.get();
      const signal = AbortSignal.timeout(2_000);
      const peerPongs = on(ws, "pong", { signal });
      const serverPongs = on(socket, "pong", { signal });
      const response = onceMessage(ws, (value) => value.type === "res" && value.id === "held");
      void response.catch(() => {});
      try {
        const marker = onceMessage(ws, (value) => value.type === "res" && value.id === "marker");
        injectReceiveChunk(stream, [
          maskedFrame(0x89, "first"),
          maskedFrame(0x81, JSON.stringify({ type: "req", id: "held", method: "test.trace" })),
          maskedFrame(0x8a, "client-pong"),
          maskedFrame(0x89, "second"),
          maskedFrame(0x81, JSON.stringify({ type: "req", id: "marker", method: "test.trace" })),
        ]);
        expect((await peerPongs.next()).value?.[0].toString()).toBe("first");
        expect((await peerPongs.next()).value?.[0].toString()).toBe("second");
        expect((await serverPongs.next()).value?.[0].toString()).toBe("client-pong");
        await expect(marker).resolves.toMatchObject({ ok: true });
        expect(completed).toBe(false);
        socket.ping("keepalive");
        expect((await serverPongs.next()).value?.[0].toString()).toBe("keepalive");
        held.resolve();
        await expect(response).resolves.toMatchObject({ ok: true });
      } finally {
        held.resolve();
        await response.catch(() => {});
        await peerPongs.return?.();
        await serverPongs.return?.();
      }
    });
  });

  it("completes an ordinary operator request after a coalesced native close", async () => {
    const held = createDeferredCore();
    const completed = createDeferredCore();
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers["test.trace"] = async ({ req, respond }) => {
      if (req.id === "held") {
        await held.promise;
        completed.resolve();
      }
      respond(true);
    };
    registerMethods(registry);
    setTestPluginRegistry(registry);
    await withServer(async ({ capture, open }) => {
      try {
        const ws = await openOperatorSocket(open);
        await sendTraceRequest(ws, "warmup");
        const { socket, stream } = capture.get();
        const signal = AbortSignal.timeout(2_000);
        const closed = Promise.all([
          once(socket, "close", { signal }),
          once(ws, "close", { signal }),
        ]);
        const responses: unknown[] = [];
        ws.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data));
          if (frame.type === "res" && frame.id === "held") {
            responses.push(frame);
          }
        });
        injectReceiveChunk(stream, [
          maskedFrame(0x81, JSON.stringify({ type: "req", id: "held", method: "test.trace" })),
          maskedFrame(0x88, ""),
        ]);
        await closed;
        expect(socket.readyState).toBe(WebSocket.CLOSED);
        held.resolve();
        await completed.promise;
        expect(responses).toEqual([]);
      } finally {
        held.resolve();
      }
    });
  });

  it.each(["preauth", "node"] as const)(
    "retains native control-frame yielding for %s sockets",
    async (role) => {
      let sentinel: ReturnType<typeof setImmediate> | undefined;
      let removePingObserver: (() => void) | undefined;
      await withServer(async ({ capture, open }) => {
        try {
          const ws = open();
          trackConnectChallengeNonce(ws);
          await once(ws, "open");
          if (role === "node") {
            await connectOk(ws, {
              token,
              role: "node",
              prePairDevice: true,
              client: { id: "node-host", version: "dev", platform: "test", mode: "node" },
              scopes: [],
              caps: [],
              commands: [],
            });
          }
          const { socket, stream } = capture.get();
          const events: string[] = [];
          const recordPing = (data: Buffer) => {
            const value = data.toString();
            events.push(value);
            if (value === "first") {
              sentinel = setImmediate(() => events.push("yield"));
            }
          };
          socket.on("ping", recordPing);
          removePingObserver = () => socket.off("ping", recordPing);
          const pings = on(socket, "ping", { signal: AbortSignal.timeout(2_000) });
          try {
            injectReceiveChunk(stream, [maskedFrame(0x89, "first"), maskedFrame(0x89, "second")]);
            await pings.next();
            await pings.next();
            expect(events).toEqual(["first", "yield", "second"]);
          } finally {
            await pings.return?.();
          }
        } finally {
          clearImmediate(sentinel);
          removePingObserver?.();
        }
      });
    },
  );

  it("keeps local frames raw and compresses remote frames both ways without stalling", async () => {
    await writeConfigFile({ gateway: { trustedProxies: ["127.0.0.1"] } });
    const registry = createEmptyPluginRegistry();
    const sharedMessages = [
      { text: 'Escaped "segment" 漢字🦞\n'.repeat(4096) },
      { text: randomBytes(1536).toString("base64").repeat(16) },
    ];
    const sharedBytes = Buffer.from(JSON.stringify(sharedMessages));
    registerDeflatedSegment(
      sharedBytes,
      deflateRawSync(sharedBytes, { level: 1, finishFlush: zlibConstants.Z_SYNC_FLUSH }),
    );
    registry.gatewayHandlers["test.echo"] = async ({ req, respond, acceptsDeflatedSegments }) => {
      respond(true, {
        echoed: (req.params as { text: string }).text,
        acceptsDeflatedSegments: acceptsDeflatedSegments === true,
      });
    };
    registry.gatewayHandlers["test.segments"] = async ({ respond }) => {
      respond(true, { messages: new SerializedJsonArray(sharedBytes) });
    };
    registerMethods(registry, ["test.segments", "test.echo"]);
    // Real Gateways advertise many plugin methods; push hello past the compression threshold.
    for (let index = 0; index < 64; index++) {
      registry.gatewayMethodDescriptors.push(
        createPluginGatewayMethodDescriptor({
          pluginId: "request-start-proof",
          name: `test.padding.hello-method-${index}`,
          handler: registry.gatewayHandlers["test.echo"],
        }),
      );
    }
    setTestPluginRegistry(registry);
    await withServer(async ({ capture, open }) => {
      const local = open();
      await once(local, "open");
      expect(local.extensions).toBe("");
      const localClosed = once(local, "close");
      local.close();
      await localClosed;
      for (const perMessageDeflate of [false, {}]) {
        const peer = open({
          perMessageDeflate,
          headers: { "x-forwarded-for": "198.51.100.10" },
        });
        try {
          trackConnectChallengeNonce(peer);
          await once(peer, "open");
          await connectOk(peer, { token, prePairDevice: true });
          const response = onceMessage(peer, (value) => value.id === "capability");
          peer.send(rpc("capability", "test.echo", { text: "capability" }));
          await expect(response).resolves.toMatchObject({
            ok: true,
            payload: { acceptsDeflatedSegments: perMessageDeflate !== false },
          });
        } finally {
          peer.terminate();
        }
      }
      // Peers may cap the server window; its inflater rejects farther back-references.
      const socket = open({
        perMessageDeflate: { serverMaxWindowBits: 10 },
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      trackConnectChallengeNonce(socket);
      const upgraded = once(socket, "upgrade");
      await once(socket, "open");
      const [upgrade] = (await upgraded) as [IncomingMessage];
      expect(upgrade.headers["sec-websocket-extensions"]).toContain("server_max_window_bits=10");
      const { stream } = capture.get();
      // Device tokens ride in hello; secrets never share a compressed frame.
      const beforeHello = stream.bytesWritten;
      const hello = JSON.stringify(await connectOk(socket, { token, prePairDevice: true }));
      expect(hello.length).toBeGreaterThan(16 * 1024);
      expect(stream.bytesWritten - beforeHello).toBeGreaterThan(hello.length);
      const echo = async (
        id: string,
        text: string,
        send = () => socket.send(rpc(id, "test.echo", { text })),
      ) => {
        const response = onceMessage(socket, (value) => value.type === "res" && value.id === id);
        const before = stream.bytesWritten;
        send();
        await expect(response).resolves.toMatchObject({
          ok: true,
          payload: { echoed: text, acceptsDeflatedSegments: false },
        });
        return stream.bytesWritten - before;
      };
      const request = (id: string, text: string) => rpc(id, "test.echo", { text });
      // A worker's window-15 cache must not bypass this peer's window-10 limit.
      // The second response reuses the same segment with a fresh RPC envelope.
      for (const id of ["segments-first", "segments-again"]) {
        const response = once(socket, "message");
        const before = stream.bytesWritten;
        socket.send(rpc(id, "test.segments"));
        const [data] = await response;
        const expected = JSON.stringify({
          type: "res",
          id,
          ok: true,
          payload: { messages: sharedMessages },
        });
        expect(rawDataToString(data)).toBe(expected);
        expect(stream.bytesWritten - before).toBeLessThan(Buffer.byteLength(expected) / 4);
      }
      // Live session/tool events stay raw below the threshold.
      const smallText = "x".repeat(GATEWAY_PER_MESSAGE_DEFLATE.threshold / 2);
      expect(await echo("small", smallText)).toBeGreaterThan(smallText.length);
      const inlineText = "x".repeat(MAX_PREAUTH_PAYLOAD_BYTES * 2);
      for (const [id, text] of [
        ["medium", "x".repeat(6 * 1024)],
        ["inline", inlineText],
        ["repetitive", "x".repeat(2 * 1024 * 1024)],
      ] as const) {
        expect(await echo(id, text)).toBeLessThan(text.length / 4);
      }
      // Repeats farther apart than the negotiated window must not be referenced.
      const windowText = randomBytes(1536).toString("base64").repeat(16);
      await echo("window", windowText);
      // Barely compressible frames still round-trip.
      const randomText = randomBytes(384 * 1024).toString("base64");
      await echo("random", randomText);
      // Fragmented compressed requests inflate once the final fragment arrives.
      const fragmented = request("fragmented", inlineText);
      const split = fragmented.length >> 1;
      await echo("fragmented", inlineText, () => {
        socket.send(fragmented.slice(0, split), { fin: false });
        socket.send("", { fin: false });
        socket.send(fragmented.slice(split), { fin: false });
        socket.send("", { fin: true });
      });
      // Inflated size stays bounded by the authenticated frame limit.
      const closed = once(socket, "close");
      socket.send(request("bomb", "x".repeat(MAX_PAYLOAD_BYTES)));
      expect((await closed)[0]).toBe(1009);
    });
  });

  it("rejects an operator handshake visibly when the receiver handoff field is not writable", async () => {
    await withServer(async ({ capture, open }) => {
      const ws = open();
      trackConnectChallengeNonce(ws);
      await once(ws, "open");
      const { socket } = capture.get();
      const receiver = (socket as WebSocket & { _receiver: object })["_receiver"];
      const descriptor = Object.getOwnPropertyDescriptor(receiver, "_allowSynchronousEvents");
      expect(descriptor).toMatchObject({ value: false, writable: true });
      // Fault injection is confined to this dependency-drift case. The burst
      // regression above exercises the source handoff without private mutation.
      Object.defineProperty(receiver, "_allowSynchronousEvents", {
        ...descriptor,
        writable: false,
      });
      const closed = once(ws, "close");
      void closed.catch(() => {});
      await expect(connectReq(ws, { token })).resolves.toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "unsupported Gateway WebSocket receiver" },
      });
      expect((await closed)[0]).toBe(1011);
    });
  });
});
