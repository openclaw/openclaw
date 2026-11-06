import { afterEach, expect, test, vi } from "vitest";
import type { Connection, Endpoint } from "../../crates/openclaw-iroh-node/index.js";
import { NodeTunnelConnection } from "./openclaw-id-connection.js";

const sessions: NodeTunnelConnection[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  vi.useRealTimers();
});
function fixture(code?: number) {
  const closed = new Promise<Awaited<ReturnType<Connection["closed"]>>>((resolve) => {
    if (code !== undefined) {
      resolve({ code, kind: "application", reason: "deliberately unrelated text" });
    }
  });
  const close = vi.fn();
  const conn: Connection = {
    remoteId: () => "aa".repeat(32),
    openBi: vi.fn(),
    acceptBi: vi.fn(),
    setMaxConcurrentBiStreams: vi.fn(),
    close,
    closed: () => closed,
    pathKind: () => "direct",
    rttMs: () => 1,
  };
  const connect = vi.fn(async () => conn);
  const endpoint: Endpoint = {
    id: () => "bb".repeat(32),
    boundSockets: () => [],
    online: vi.fn(),
    homeRelayStatus: () => [],
    watchHomeRelay: vi.fn(),
    accept: vi.fn(),
    connect,
    close: vi.fn(),
  };
  const terminal = vi.fn();
  const session = new NodeTunnelConnection({
    endpoint,
    serverKey: `iroh:${"aa".repeat(32)}`,
    onTerminal: terminal,
  });
  sessions.push(session);
  return { session, endpoint, conn, terminal, connect, close };
}

test.each([1, 2])(
  "stops on admission/removal code %s, independent of reason text",
  async (code) => {
    const { session, connect, terminal } = fixture(code);
    await expect(session.connection()).rejects.toThrow("re-join this node");
    await expect(session.connection()).rejects.toThrow("re-join this node");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
  },
);

test("waits for admission, shares one dial, then probes a silent connection", async () => {
  vi.useFakeTimers();
  const { session, connect, conn, close } = fixture();
  const first = session.connection();
  const second = session.connection();
  await vi.advanceTimersByTimeAsync(500);
  expect(await first).toBe(conn);
  expect(await second).toBe(conn);
  expect(connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledWith(0, "probe complete");
});

test("backs off relay-denied dials instead of a tight retry loop", async () => {
  vi.useFakeTimers();
  const { session, endpoint, connect } = fixture();
  endpoint.homeRelayStatus = () => [
    { url: "https://relay.invalid", connected: false, authDeniedReason: "denied" },
  ];
  connect.mockRejectedValue(new Error("relay denied"));
  const first = session.connection();
  const firstRejected = expect(first).rejects.toThrow("relay denied");
  await vi.advanceTimersByTimeAsync(0);
  await firstRejected;
  const next = session.connection();
  const nextRejected = expect(next).rejects.toThrow("relay denied");
  await vi.advanceTimersByTimeAsync(9_999);
  expect(connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await nextRejected;
  expect(connect).toHaveBeenCalledTimes(2);
});
