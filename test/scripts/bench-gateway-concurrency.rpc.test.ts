import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.ts";
import { testing } from "../../scripts/bench-gateway-concurrency.ts";

type Request = { id: string; method: string };
let server: WebSocketServer | undefined;
let client: Awaited<ReturnType<typeof testing.connectGateway>> | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  client?.close();
  client = undefined;
  for (const peer of server?.clients ?? []) {
    peer.terminate();
  }
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

async function connect(onRequest?: (frame: Request, peer: WebSocket) => void) {
  const requests = new EventEmitter();
  const observed: Request[] = [];
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (peer) => {
    peer.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as Request;
      if (frame.method === "connect") {
        peer.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: {} }));
        return;
      }
      observed.push(frame);
      requests.emit("request", frame);
      onRequest?.(frame, peer);
    });
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  client = await testing.connectGateway(address.port, performance.now() + 5_000, 3, false);
  return { client, requests, observed };
}

function readTiming(error: unknown): unknown {
  assert(error instanceof Error);
  const prefix = "\nRPC failure timing: ";
  const offset = error.message.indexOf(prefix);
  assert(offset >= 0, "the failed request must retain its selected budget");
  return JSON.parse(error.message.slice(offset + prefix.length));
}

describe("benchmark RPC failure timing", () => {
  it.each([
    { name: "default RPC cap", remaining: 240_000, cap: undefined, selected: 65_000 },
    { name: "aggregate deadline", remaining: 90, cap: undefined, selected: 90 },
    { name: "explicit RPC cap", remaining: 240_000, cap: 25, selected: 25 },
    { name: "minimum timer", remaining: 0.25, cap: undefined, selected: 1 },
  ])("records the $name without changing its timer", async ({ remaining, cap, selected }) => {
    const socket = await connect();
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.client.setDeadlineAt(1_000 + remaining);
    const received = once(socket.requests, "request");
    const outcome = socket.client.request("chat.inject", {}, cap).catch((error: unknown) => error);
    await received;
    now.mockReturnValue(1_000 + selected);
    await vi.advanceTimersByTimeAsync(selected);
    const error = await outcome;
    assert(error instanceof Error);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toMatchObject({ message: "timeout waiting for chat.inject" });
    expect(readTiming(error)).toEqual({
      method: "chat.inject",
      issuedAtMs: 1_000,
      deadlineAtMs: 1_000 + remaining,
      remainingAtIssueMs: remaining,
      requestedCapMs: cap ?? 65_000,
      selectedTimeoutMs: selected,
      scheduledExpiryAtMs: 1_000 + selected,
      rejectedAtMs: 1_000 + selected,
      remainingAtRejectionMs: Math.max(0, remaining - selected),
    });
  });

  it("retains an outstanding request's budget when the next phase changes the deadline", async () => {
    const socket = await connect();
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    socket.client.setDeadlineAt(1_100);
    const received = once(socket.requests, "request");
    const outcome = socket.client.request("chat.inject", {}).catch((error: unknown) => error);
    await received;
    socket.client.setDeadlineAt(241_000);
    now.mockReturnValue(1_100);
    await vi.advanceTimersByTimeAsync(100);
    expect(readTiming(await outcome)).toMatchObject({
      deadlineAtMs: 1_100,
      remainingAtIssueMs: 100,
      selectedTimeoutMs: 100,
      scheduledExpiryAtMs: 1_100,
      rejectedAtMs: 1_100,
      remainingAtRejectionMs: 0,
    });
  });

  it("refuses an exhausted deadline before dispatch", async () => {
    const socket = await connect();
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    socket.client.setDeadlineAt(1_000);
    await expect(socket.client.request("chat.inject", {})).rejects.toThrow(
      "benchmark timed out while waiting for chat.inject",
    );
    expect(socket.observed).toEqual([]);
  });

  it("keeps socket closure as the cause without calling it a timeout", async () => {
    const socket = await connect((_frame, peer) => peer.close(1011, "fixture shutdown"));
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    socket.client.setDeadlineAt(241_000);
    const error = await socket.client.request("chat.inject", {}).catch((cause: unknown) => cause);
    assert(error instanceof Error);
    expect(error.cause).toMatchObject({
      message: "gateway websocket closed (1011): fixture shutdown",
    });
    expect(error.message).not.toContain("timeout waiting");
    expect(readTiming(error)).toMatchObject({
      selectedTimeoutMs: 65_000,
      rejectedAtMs: 1_000,
      remainingAtRejectionMs: 240_000,
    });
  });

  it("preserves successful payloads and server rejections", async () => {
    const socket = await connect((frame, peer) => {
      peer.send(
        JSON.stringify(
          frame.method === "health"
            ? { type: "res", id: frame.id, ok: true, payload: { ready: true } }
            : { type: "res", id: frame.id, ok: false, error: { message: "fixture rejected" } },
        ),
      );
    });
    await expect(socket.client.request("health", {})).resolves.toEqual({ ready: true });
    await expect(socket.client.request("chat.inject", {})).rejects.toThrow(
      "chat.inject failed: fixture rejected",
    );
  });
});
