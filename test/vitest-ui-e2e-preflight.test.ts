import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertUiE2ePreflight } from "./vitest/vitest.ui-e2e-preflight.ts";

vi.mock("node:http", { spy: true });

const listeners: Array<{
  server: ReturnType<typeof createServer>;
  closed: ReturnType<typeof vi.fn>;
}> = [];

beforeEach(async () => {
  listeners.length = 0;
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  vi.mocked(createServer).mockImplementation((...args) => {
    const server = actual.createServer(...args);
    const closed = vi.fn();
    server.on("close", closed);
    listeners.push({ server, closed });
    return server;
  });
});

afterEach(async () => {
  // Keep a failed cleanup assertion from leaking its real listener into later tests.
  for (const { server } of listeners) {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});

function expectListenerClosed() {
  // A released ephemeral port can already belong to another worker or an outbound socket.
  expect(listeners).toHaveLength(1);
  const listener = listeners[0]!;
  expect(listener.closed).toHaveBeenCalledOnce();
  expect(listener.server.listening).toBe(false);
  expect(listener.server.address()).toBeNull();
}

describe("UI E2E environment preflight", () => {
  it("proves the owned HTTP response and releases its listener", async () => {
    const fetchImpl = vi.fn<typeof fetch>(fetch);
    await assertUiE2ePreflight({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expectListenerClosed();
  });

  it("reports proxy HTTP failures without exposing remote content", async () => {
    const secret = "synthetic-private-proxy-details";
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(secret, { status: 502, headers: { "x-private-proxy": secret } }),
    );
    const failure = await assertUiE2ePreflight({ fetchImpl }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("UI E2E loopback HTTP preflight received HTTP 502");
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).toContain("do not disable its proxy policy");
    expectListenerClosed();
  });

  it("rejects a successful status from a different endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await expect(assertUiE2ePreflight({ fetchImpl })).rejects.toThrow(
      "instead of the owned response",
    );
    expectListenerClosed();
  });

  it("aborts a stalled request and releases its listener before reporting the deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            throw new Error("Expected owned abort signal");
          }
          if (signal.aborted) {
            reject(new Error("synthetic-private-timeout"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("synthetic-private-timeout")), {
            once: true,
          });
        }),
    );
    await expect(assertUiE2ePreflight({ fetchImpl, timeoutMs: 50 })).rejects.toThrow(
      "loopback HTTP preflight timed out",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expectListenerClosed();
  });
});
