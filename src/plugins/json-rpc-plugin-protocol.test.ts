import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { JsonRpcPeer } from "./json-rpc-peer.js";
import { JsonRpcPluginProtocol } from "./json-rpc-plugin-protocol.js";

describe("JsonRpcPluginProtocol", () => {
  it("dispatches permitted host calls and rejects undeclared capabilities", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const api = createTestPluginApi({
      runtime: {
        system: {
          requestHeartbeat: async () => ({ ok: true }),
        },
      } as never,
    });
    const peerRef: { current?: JsonRpcPeer } = {};
    const protocol = new JsonRpcPluginProtocol(
      api,
      new Set(["runtime.system.requestHeartbeat"]),
      () => peerRef.current!,
    );
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      requestHandlers: protocol.requestHandlers,
    });
    peerRef.current = peer;

    peer.handle({
      jsonrpc: "2.0",
      id: "allowed",
      method: "openclaw.host.call",
      params: { method: "runtime.system.requestHeartbeat", args: [] },
    });
    peer.handle({
      jsonrpc: "2.0",
      id: "denied",
      method: "openclaw.host.call",
      params: { method: "runtime.config.current", args: [] },
    });

    await vi.waitFor(() => expect(written.split("\n").filter(Boolean)).toHaveLength(2));
    const responses = written
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: "allowed", result: { ok: true } });
    expect(responses).toContainEqual({
      jsonrpc: "2.0",
      id: "denied",
      error: {
        code: -32603,
        message: "host capability not permitted: runtime.config.current",
      },
    });
  });

  it("materializes RPC callbacks and remote streams", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const api = createTestPluginApi();
    const peerRef: { current?: JsonRpcPeer } = {};
    const protocol = new JsonRpcPluginProtocol(api, new Set(), () => peerRef.current!);
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      notificationHandlers: protocol.notificationHandlers,
    });
    peerRef.current = peer;
    const callback = protocol.materialize({ $rpc: "plugin.callback" }) as (
      value: string,
    ) => Promise<unknown>;
    const result = callback("value");
    peer.handle({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    await expect(result).resolves.toEqual({ ok: true });
    expect(written).toContain('"method":"plugin.callback"');

    const stream = protocol.materialize({ $stream: "plugin-stream" }) as AsyncIterable<string>;
    const collected = collect(stream);
    peer.handle({
      jsonrpc: "2.0",
      method: "$/stream/chunk",
      params: { id: "plugin-stream", chunk: "a" },
    });
    peer.handle({ jsonrpc: "2.0", method: "$/stream/end", params: { id: "plugin-stream" } });
    await expect(collected).resolves.toEqual(["a"]);
  });

  it("encodes bytes and rejects cyclic values", () => {
    const api = createTestPluginApi();
    const peer = new JsonRpcPeer({
      write: new PassThrough(),
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
    });
    const protocol = new JsonRpcPluginProtocol(api, new Set(), () => peer);

    expect(protocol.serialize(Buffer.from("hello"))).toEqual({
      $bytes: Buffer.from("hello").toString("base64"),
    });
    expect(protocol.materialize({ $bytes: "aGVsbG8=" })).toEqual(Buffer.from("hello"));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => protocol.serialize(cyclic)).toThrow("contains a cycle");
  });

  it("fails pending remote streams when the protocol is disposed", async () => {
    const peer = new JsonRpcPeer({
      write: new PassThrough(),
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
    });
    const protocol = new JsonRpcPluginProtocol(createTestPluginApi(), new Set(), () => peer);
    const stream = protocol.materialize({ $stream: "pending-stream" }) as AsyncIterable<unknown>;
    const next = stream[Symbol.asyncIterator]().next();

    protocol.dispose(new Error("transport closed"));

    await expect(next).rejects.toThrow("transport closed");
  });

  it("waits for stream readiness before publishing values", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const peerRef: { current?: JsonRpcPeer } = {};
    const protocol = new JsonRpcPluginProtocol(
      createTestPluginApi(),
      new Set(),
      () => peerRef.current!,
    );
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      notificationHandlers: protocol.notificationHandlers,
    });
    peerRef.current = peer;
    const reference = protocol.serialize(
      (async function* () {
        yield "first";
      })(),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(written).toBe("");
    peer.handle({
      jsonrpc: "2.0",
      method: "$/stream/ready",
      params: { id: (reference as { $stream: string }).$stream },
    });
    await vi.waitFor(() => expect(written).toContain('"method":"$/stream/chunk"'));
    expect(written).toContain('"method":"$/stream/end"');
  });

  it("bounds retained callbacks", () => {
    const peer = new JsonRpcPeer({
      write: new PassThrough(),
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
    });
    const protocol = new JsonRpcPluginProtocol(createTestPluginApi(), new Set(), () => peer);
    for (let index = 0; index < 1024; index += 1) {
      protocol.serialize(() => index);
    }
    expect(() => protocol.serialize(() => undefined)).toThrow("retained callback limit exceeded");
  });

  it("cancels active published streams on disposal", async () => {
    const peerRef: { current?: JsonRpcPeer } = {};
    const protocol = new JsonRpcPluginProtocol(
      createTestPluginApi(),
      new Set(),
      () => peerRef.current!,
    );
    const peer = new JsonRpcPeer({
      write: new PassThrough(),
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      notificationHandlers: protocol.notificationHandlers,
    });
    peerRef.current = peer;
    let returned = false;
    const iterable: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const reference = protocol.serialize(iterable) as { $stream: string };
    peer.handle({
      jsonrpc: "2.0",
      method: "$/stream/ready",
      params: { id: reference.$stream },
    });

    protocol.dispose();

    await vi.waitFor(() => expect(returned).toBe(true));
  });

  it("waits for transport writes before pulling the next stream value", async () => {
    const writeCallbacks: Array<() => void> = [];
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writeCallbacks.push(callback);
      },
    });
    const peerRef: { current?: JsonRpcPeer } = {};
    const protocol = new JsonRpcPluginProtocol(
      createTestPluginApi(),
      new Set(),
      () => peerRef.current!,
    );
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      notificationHandlers: protocol.notificationHandlers,
    });
    peerRef.current = peer;
    let pulls = 0;
    const reference = protocol.serialize(
      (async function* () {
        pulls += 1;
        yield "first";
        pulls += 1;
        yield "second";
      })(),
    ) as { $stream: string };

    peer.handle({
      jsonrpc: "2.0",
      method: "$/stream/ready",
      params: { id: reference.$stream },
    });
    await vi.waitFor(() => expect(writeCallbacks).toHaveLength(1));
    expect(pulls).toBe(1);
    writeCallbacks.shift()?.();
    await vi.waitFor(() => expect(writeCallbacks).toHaveLength(1));
    expect(pulls).toBe(2);
    peer.close(new Error("done"));
    writeCallbacks.shift()?.();
  });

  it("cancels remote producers when a consumer stops early", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const peerRef: { current?: JsonRpcPeer } = {};
    const protocol = new JsonRpcPluginProtocol(
      createTestPluginApi(),
      new Set(),
      () => peerRef.current!,
    );
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      notificationHandlers: protocol.notificationHandlers,
    });
    peerRef.current = peer;
    const stream = protocol.materialize({ $stream: "remote" }) as AsyncIterable<string>;
    const iterator = stream[Symbol.asyncIterator]();
    peer.handle({
      jsonrpc: "2.0",
      method: "$/stream/chunk",
      params: { id: "remote", chunk: "first" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });

    await iterator.return?.();

    await vi.waitFor(() => expect(written).toContain('"method":"$/stream/cancel"'));
  });

  it("returns host iterators when the remote consumer cancels", async () => {
    const peerRef: { current?: JsonRpcPeer } = {};
    const protocol = new JsonRpcPluginProtocol(
      createTestPluginApi(),
      new Set(),
      () => peerRef.current!,
    );
    const peer = new JsonRpcPeer({
      write: new PassThrough(),
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      notificationHandlers: protocol.notificationHandlers,
    });
    peerRef.current = peer;
    let returned = false;
    const reference = protocol.serialize({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    }) as { $stream: string };
    peer.handle({ jsonrpc: "2.0", method: "$/stream/ready", params: { id: reference.$stream } });
    peer.handle({ jsonrpc: "2.0", method: "$/stream/cancel", params: { id: reference.$stream } });

    await vi.waitFor(() => expect(returned).toBe(true));
  });

  it("passes callback request cancellation to abort-signal arguments", async () => {
    const output = new PassThrough();
    const peerRef: { current?: JsonRpcPeer } = {};
    let receivedSignal: AbortSignal | undefined;
    const protocol = new JsonRpcPluginProtocol(
      createTestPluginApi(),
      new Set(),
      () => peerRef.current!,
    );
    const reference = protocol.serialize((signal: AbortSignal) => {
      receivedSignal = signal;
    }) as { $callback: string };
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
      requestHandlers: protocol.requestHandlers,
    });
    peerRef.current = peer;
    peer.handle({
      jsonrpc: "2.0",
      id: "callback",
      method: "openclaw.callback.invoke",
      params: { id: reference.$callback, args: [{ $abortSignal: true }] },
    });
    peer.handle({
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: "callback" },
    });

    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
  });

  it("uses nested abort signals to cancel remote callbacks", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
    });
    const protocol = new JsonRpcPluginProtocol(createTestPluginApi(), new Set(), () => peer);
    const callback = protocol.materialize({ $rpc: "compaction.summarize" }) as (params: {
      signal: AbortSignal;
    }) => Promise<unknown>;
    const controller = new AbortController();
    const pending = callback({ signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
    expect(written).toContain('"$abortSignal":true');
    expect(written).toContain('"method":"$/cancelRequest"');
  });

  it("uses nested abort signals to cancel child-owned callback handles", async () => {
    const output = new PassThrough();
    let written = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => (written += String(chunk)));
    const peer = new JsonRpcPeer({
      write: output,
      requestTimeoutMs: 1000,
      maxPendingRequests: 4,
    });
    const protocol = new JsonRpcPluginProtocol(createTestPluginApi(), new Set(), () => peer);
    const callback = protocol.materialize({ $callback: "child-callback" }) as (params: {
      signal: AbortSignal;
    }) => Promise<unknown>;
    const controller = new AbortController();
    const pending = callback({ signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
    expect(written).toContain('"$abortSignal":true');
    expect(written).toContain('"method":"$/cancelRequest"');
  });
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}
