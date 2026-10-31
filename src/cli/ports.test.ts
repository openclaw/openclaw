import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const mockCreateServer = vi.hoisted(() => vi.fn());

vi.mock("node:net", async () => {
  const actual = await vi.importActual<typeof import("node:net")>("node:net");
  return { ...actual, createServer: mockCreateServer };
});

import { waitForPortBindable } from "./ports.js";

function makeServer(code?: string) {
  const server = new EventEmitter();
  return Object.assign(server, {
    close: (callback?: () => void) => {
      callback?.();
      return server;
    },
    unref: () => server,
    listen: vi.fn((_port: number, _host: string, callback: () => void) => {
      setImmediate(() =>
        code
          ? server.emit("error", Object.assign(new Error(`bind error: ${code}`), { code }))
          : callback(),
      );
      return server;
    }),
  });
}

describe("waitForPortBindable", () => {
  it("probes the provided host when waiting for bindability", async () => {
    const fakeServer = makeServer();
    mockCreateServer.mockReturnValue(fakeServer);

    await expect(
      waitForPortBindable(9999, { timeoutMs: 100, intervalMs: 10, host: "127.0.0.1" }),
    ).resolves.toBe(0);
    expect(fakeServer.listen).toHaveBeenNthCalledWith(1, 9999, "127.0.0.1", expect.any(Function));
  });

  it.each([
    ["EACCES", 80, undefined],
    ["EADDRNOTAVAIL", 9999, "192.0.2.1"],
    ["EINVAL", 9999, "192.0.2.1"],
  ] as const)("propagates non-retryable %s bind errors immediately", async (code, port, host) => {
    mockCreateServer.mockClear();
    mockCreateServer.mockReturnValue(makeServer(code));

    await expect(
      waitForPortBindable(port, { timeoutMs: 5000, intervalMs: 50, host }),
    ).rejects.toMatchObject({ code });
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized bindability intervals by the remaining timeout", async () => {
    mockCreateServer.mockReturnValue(makeServer("EADDRINUSE"));

    await expect(
      waitForPortBindable(9999, {
        timeoutMs: 1,
        intervalMs: Number.MAX_SAFE_INTEGER,
        host: "127.0.0.1",
      }),
    ).rejects.toThrow(/still not bindable after 1ms/);
  });
});
