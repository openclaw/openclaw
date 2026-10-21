import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { assertUiE2ePreflight } from "./vitest/vitest.ui-e2e-preflight.ts";

type Listener = [ReturnType<typeof createServer>, ReturnType<typeof vi.fn>];
const listeners = vi.hoisted(() => new Array<Listener>());
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  const trackedServer = vi.fn(actual.createServer);
  trackedServer.mockImplementation((...args) => {
    const server = actual.createServer(...args),
      closed = vi.fn();
    server.on("close", closed);
    listeners.push([server, closed]);
    return server;
  });
  return { ...actual, createServer: trackedServer };
});
afterAll(() => vi.mocked(createServer).mockRestore());

afterEach(async () => {
  try {
    // Keep a failed cleanup assertion from leaking its real listener into later tests.
    for (const [server] of listeners) {
      server.closeAllConnections();
      if (server.listening) {
        await promisify(server.close.bind(server))();
      }
    }
  } finally {
    listeners.length = 0;
  }
});

async function preflight(fetchImpl: typeof fetch = fetch, timeoutMs?: number) {
  const request = vi.fn(fetchImpl);
  try {
    await assertUiE2ePreflight({ fetchImpl: request, timeoutMs });
  } finally {
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]?.signal).toMatchObject({ aborted: true });
    expect(listeners).toHaveLength(1);
    const [server, closed] = listeners[0]!;
    expect(closed).toHaveBeenCalledOnce();
    expect([server.listening, server.address()]).toEqual([false, null]);
  }
}

it("preserves native HTTP and socket implementations for later shared-worker consumers", () => {
  const http = process.getBuiltinModule("node:http");
  const { Socket } = process.getBuiltinModule("node:net");
  const nativeMethod = expect.toSatisfy((implementation) => !vi.isMockFunction(implementation));
  expect(http).toMatchObject({
    Server: nativeMethod,
    Agent: nativeMethod,
    IncomingMessage: nativeMethod,
    OutgoingMessage: nativeMethod,
    ServerResponse: nativeMethod,
    ClientRequest: nativeMethod,
    createServer: nativeMethod,
  });
  expect(Socket).toEqual(nativeMethod);
  expect(http.IncomingMessage.prototype).toHaveProperty("read", nativeMethod);
  expect(http.OutgoingMessage.prototype).toHaveProperty("write", nativeMethod);
  expect(http.OutgoingMessage.prototype).toHaveProperty("end", nativeMethod);
  expect(http.globalAgent).toHaveProperty("createConnection", nativeMethod);
  expect(Socket.prototype).toHaveProperty("write", nativeMethod);
});

it("proves the owned HTTP response and releases its listener", () => preflight());

it.each([502, 204])("rejects unowned HTTP %i without exposing remote content", async (status) => {
  const secret = "synthetic-private-proxy-details";
  const fetchImpl = async () =>
    new Response(status === 204 ? null : secret, {
      status,
      headers: { "x-private-proxy": secret },
    });
  const failure = await preflight(fetchImpl).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain(
    `UI E2E loopback HTTP preflight received HTTP ${status} instead of the owned response`,
  );
  expect(String(failure)).not.toContain(secret);
  expect(String(failure)).toContain("do not disable its proxy policy");
});

it("aborts a stalled request and releases its listener before reporting the deadline", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Expected owned abort signal");
    }
    if (!signal.aborted) {
      await once(signal, "abort");
    }
    throw new Error("synthetic-private-timeout");
  };
  await expect(preflight(fetchImpl, 50)).rejects.toThrow("loopback HTTP preflight timed out");
});
