import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { listenGatewayHttpServer } from "./http-listen.js";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));

// mock-isolation: Control retry timing without loading unrelated utility dependencies.
vi.mock("../../utils.js", () => ({ sleep: (ms: number) => sleepMock(ms) }));

function createFakeHttpServer(errors: string[], closeFailure?: "callback" | "throw") {
  return new (class extends EventEmitter {
    public closeCalls = 0;
    listen() {
      const code = errors.shift();
      setImmediate(() => {
        if (code) {
          this.emit("error", Object.assign(new Error(code), { code }));
        } else {
          this.emit("listening");
        }
      });
      return this;
    }

    close(cb?: (error?: Error) => void) {
      this.closeCalls += 1;
      const error = new Error("retry cleanup failed");
      if (closeFailure === "throw") {
        throw error;
      }
      if (closeFailure === "callback") {
        cb?.(error);
      } else {
        setImmediate(() => cb?.());
      }
      return this;
    }
  })();
}

function listen(
  httpServer: HttpServer | ReturnType<typeof createFakeHttpServer>,
  retryEaddrinuse = true,
) {
  return listenGatewayHttpServer({
    httpServer: httpServer as HttpServer,
    bindHost: "127.0.0.1",
    port: 18789,
    retryEaddrinuse,
  });
}

beforeEach(() => sleepMock.mockClear());
it("releases its listeners when native listen throws synchronously", async () => {
  const server = createServer();
  server.on("error", vi.fn());
  server.on("listening", vi.fn());
  const errorListeners = server.listeners("error");
  const listeningListeners = server.listeners("listening");

  await expect(
    listenGatewayHttpServer({ httpServer: server, bindHost: "127.0.0.1", port: 65_536 }),
  ).rejects.toMatchObject({
    name: "GatewayLockError",
    cause: { code: "ERR_SOCKET_BAD_PORT" },
  });

  expect(server.listeners("error")).toEqual(errorListeners);
  expect(server.listeners("listening")).toEqual(listeningListeners);
});

it.each([undefined, "callback", "throw"] as const)(
  "retries after close outcome: %s",
  async (failure) => {
    const fake = createFakeHttpServer(["EADDRINUSE"], failure);
    await expect(listen(fake)).resolves.toBeUndefined();
    expect(fake.closeCalls).toBe(1);
    expect(sleepMock).toHaveBeenCalledOnce();
  },
);

it.each([
  ["exhausted retries", Array<string>(22).fill("EADDRINUSE"), true, 20],
  ["disabled retries", ["EADDRINUSE"], false, 0],
  ["non-EADDRINUSE error", ["EACCES"], true, 0],
] as const)("wraps %s as GatewayLockError", async (_reason, errors, retry, closes) => {
  const fake = createFakeHttpServer([...errors]);
  await expect(listen(fake, retry)).rejects.toBeInstanceOf(GatewayLockError);
  expect(fake.closeCalls).toBe(closes);
  if (!retry) {
    expect(sleepMock).not.toHaveBeenCalled();
  }
});
