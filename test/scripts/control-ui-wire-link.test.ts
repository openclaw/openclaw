import { once } from "node:events";
import { connect as connectSocket, createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createControlUiWireLink } from "../../scripts/lib/control-ui-wire-link.ts";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.ts";

const links: ReturnType<typeof createControlUiWireLink>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
});
afterEach(() => {
  links.splice(0).forEach((link) => link.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function linkFixture(options?: Parameters<typeof createControlUiWireLink>[0]) {
  const link = createControlUiWireLink(options);
  links.push(link);
  const connect = () => {
    const source = new PassThrough();
    const writes: Array<{ atMs: number; bytes: number }> = [];
    const startedAt = Date.now();
    const target = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writes.push({ atMs: Date.now() - startedAt, bytes: chunk.length });
        callback();
      },
    });
    const stop = link.connect(source, target, () => {});
    return { source, target, writes, stop };
  };
  return { link, connect };
}

it.each([
  { profile: "remote defaults", options: undefined, earliest: 150, latest: 158 },
  {
    profile: "mobile",
    options: { megabitsPerSecond: 3, latencyMs: 125 },
    earliest: 458,
    latest: 470,
  },
])(
  "shares throughput and overlaps propagation for $profile",
  async ({ options, earliest, latest }) => {
    const fixture = linkFixture(options);
    const first = fixture.connect();
    const second = fixture.connect();
    first.source.end(Buffer.alloc(62_500));
    second.source.end(Buffer.alloc(62_500));
    await vi.advanceTimersByTimeAsync(options?.latencyMs ? options.latencyMs - 1 : 49);
    expect([...first.writes, ...second.writes]).toEqual([]);
    await vi.advanceTimersByTimeAsync(latest);
    expect(first.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(62_500);
    expect(second.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(62_500);
    const lastDelivery = Math.max(
      ...[...first.writes, ...second.writes].map((write) => write.atMs),
    );
    expect(lastDelivery).toBeGreaterThanOrEqual(earliest);
    expect(lastDelivery).toBeLessThanOrEqual(latest);
  },
);

it("gives a small flow a turn and does not reserve cancelled bulk bytes", async () => {
  const fixture = linkFixture();
  const bulk = fixture.connect();
  const control = fixture.connect();
  bulk.source.write(Buffer.alloc(1_000_000));
  control.source.end(Buffer.alloc(748));
  await vi.advanceTimersByTimeAsync(70);
  expect(control.writes).toEqual([{ atMs: 65, bytes: 748 }]);
  bulk.target.destroy();
  await vi.advanceTimersByTimeAsync(0);
  const next = fixture.connect();
  next.source.end(Buffer.alloc(748));
  await vi.advanceTimersByTimeAsync(70);
  expect(next.writes).toHaveLength(1);
  expect(next.writes[0]!.atMs).toBeLessThanOrEqual(64);
});

it("ends only after every serialized byte arrives and tears down queued work", async () => {
  const fixture = linkFixture();
  const flow = fixture.connect();
  const finish = vi.fn();
  flow.target.on("finish", finish);
  flow.source.end(Buffer.alloc(32_768));
  await vi.advanceTimersByTimeAsync(77);
  expect(finish).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(flow.writes.reduce((sum, write) => sum + write.bytes, 0)).toBe(32_768);
  expect(finish).toHaveBeenCalledOnce();
  const cancelled = fixture.connect();
  cancelled.source.write(Buffer.alloc(1_000_000));
  fixture.link.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(cancelled.writes).toEqual([]);
  expect(cancelled.source.destroyed).toBe(true);
  expect(cancelled.target.destroyed).toBe(true);
});

it("stops feeding a blocked destination until it drains", async () => {
  const link = createControlUiWireLink();
  links.push(link);
  const source = new PassThrough();
  const callbacks: Array<() => void> = [];
  let bytes = 0;
  const target = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callbacks.push(callback);
    },
  });
  link.connect(source, target, () => {});
  source.end(Buffer.alloc(262_144));
  await vi.advanceTimersByTimeAsync(200);
  // At most one propagation window was already in flight when backpressure arrived.
  expect(bytes).toBe(16_384);
  while (callbacks.length) {
    callbacks.shift()!();
  }
  await vi.advanceTimersByTimeAsync(100);
  expect(bytes).toBeGreaterThan(16_384);
});

it("delivers a real socket response after both peers half-close", async () => {
  vi.useRealTimers();
  const sent = createControlUiWireLink();
  const received = createControlUiWireLink();
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const request = "request before client FIN";
  const response = "response before upstream FIN";
  const requestChunks: Buffer[] = [];
  const observedRequest = Promise.withResolvers<void>();
  const observedResponse = Promise.withResolvers<void>();
  const upstreamClosed = Promise.withResolvers<void>();
  const upstream = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer({ allowHalfOpen: true }, (socket) => {
        track(socket);
        socket.on("data", (chunk: Buffer) => requestChunks.push(chunk));
        socket.on("end", () => socket.end(response));
      }),
  });
  let proxy: Awaited<ReturnType<typeof reserveTestPortListener>> | undefined;
  try {
    proxy = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer({ allowHalfOpen: true }, (client) => {
          track(client);
          const remote = track(
            connectSocket({ host: "127.0.0.1", port: upstream.claim.port, allowHalfOpen: true }),
          );
          remote.once("close", () => upstreamClosed.resolve());
          sent.connect(client, remote, () => observedRequest.resolve());
          received.connect(remote, client, () => observedResponse.resolve());
        }),
    });
    const client = track(
      connectSocket({ host: "127.0.0.1", port: proxy.claim.port, allowHalfOpen: true }),
    );
    const chunks: Buffer[] = [];
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    const clientClosed = once(client, "close");
    await once(client, "connect");
    vi.useFakeTimers();
    client.end(request);
    await observedRequest.promise;
    await vi.advanceTimersByTimeAsync(60);
    await observedResponse.promise;
    await vi.advanceTimersByTimeAsync(2);
    await upstreamClosed.promise;
    expect(chunks).toEqual([]);
    await vi.advanceTimersByTimeAsync(60);
    await clientClosed;
    expect(Buffer.concat(requestChunks).toString()).toBe(request);
    expect(Buffer.concat(chunks).toString()).toBe(response);
  } finally {
    vi.useRealTimers();
    sent.close();
    received.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    if (proxy) {
      await proxy.releaseListener();
      await proxy.claim.release();
    }
    await upstream.releaseListener();
    await upstream.claim.release();
  }
});
