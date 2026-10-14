// Gateway HTTP listener tests cover retry behavior for lock contention and listen failures.
import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { listenGatewayHttpServer } from "./http-listen.js";

/**
 * Gateway HTTP listener retry tests for lock contention and listen failures.
 */
const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));

vi.mock("../../utils.js", () => ({
  sleep: (ms: number) => sleepMock(ms),
}));

type ListenOutcome = { kind: "error"; code: string } | { kind: "listening" };

function createFakeHttpServer(outcomes: ListenOutcome[]) {
  class FakeHttpServer extends EventEmitter {
    public closeCalls = 0;
    public listenCalls: unknown[][] = [];
    private attempt = 0;

    listen(...args: unknown[]) {
      this.listenCalls.push(args);
      const outcome = outcomes[this.attempt] ?? { kind: "listening" };
      this.attempt += 1;
      setImmediate(() => {
        if (outcome.kind === "error") {
          const err = Object.assign(new Error(outcome.code), { code: outcome.code });
          this.emit("error", err);
        } else {
          this.emit("listening");
        }
      });
      return this;
    }

    close(cb?: () => void) {
      this.closeCalls += 1;
      setImmediate(() => cb?.());
      return this;
    }
  }

  return new FakeHttpServer();
}

describe("listenGatewayHttpServer", () => {
  it("releases its listeners when native listen throws synchronously", async () => {
    const server = createServer();
    const onError = vi.fn();
    const onListening = vi.fn();
    server.on("error", onError);
    server.on("listening", onListening);
    const errorListeners = server.listeners("error");
    const listeningListeners = server.listeners("listening");

    await expect(
      listenGatewayHttpServer({
        httpServer: server,
        bindHost: "127.0.0.1",
        port: 65_536,
      }),
    ).rejects.toMatchObject({
      name: "GatewayLockError",
      cause: { code: "ERR_SOCKET_BAD_PORT" },
    });

    expect(server.listeners("error")).toEqual(errorListeners);
    expect(server.listeners("listening")).toEqual(listeningListeners);
    expect(onError).not.toHaveBeenCalled();
    expect(onListening).not.toHaveBeenCalled();
  });

  it("retries EADDRINUSE and closes server handle before retry", async () => {
    sleepMock.mockClear();
    const fake = createFakeHttpServer([
      { kind: "error", code: "EADDRINUSE" },
      { kind: "listening" },
    ]);

    await expect(
      listenGatewayHttpServer({
        httpServer: fake as unknown as HttpServer,
        bindHost: "127.0.0.1",
        port: 18789,
      }),
    ).resolves.toBeUndefined();

    expect(fake.closeCalls).toBe(1);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it("throws GatewayLockError after EADDRINUSE retries are exhausted", async () => {
    sleepMock.mockClear();
    const fake = createFakeHttpServer(
      Array.from({ length: 22 }, () => ({ kind: "error" as const, code: "EADDRINUSE" })),
    );

    await expect(
      listenGatewayHttpServer({
        httpServer: fake as unknown as HttpServer,
        bindHost: "127.0.0.1",
        port: 18789,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(fake.closeCalls).toBe(20);
  });

  it("fails immediately when EADDRINUSE retries are disabled", async () => {
    sleepMock.mockClear();
    const fake = createFakeHttpServer([
      { kind: "error", code: "EADDRINUSE" },
      { kind: "listening" },
    ]);

    await expect(
      listenGatewayHttpServer({
        httpServer: fake as unknown as HttpServer,
        bindHost: "127.0.0.1",
        port: 18789,
        retryEaddrinuse: false,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(fake.closeCalls).toBe(0);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("wraps non-EADDRINUSE errors as GatewayLockError", async () => {
    sleepMock.mockClear();
    const fake = createFakeHttpServer([{ kind: "error", code: "EACCES" }]);

    await expect(
      listenGatewayHttpServer({
        httpServer: fake as unknown as HttpServer,
        bindHost: "127.0.0.1",
        port: 18789,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    expect(fake.closeCalls).toBe(0);
  });
});
