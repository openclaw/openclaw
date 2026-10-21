import { EventEmitter } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";
import { GatewayLockError } from "../../infra/gateway-lock.js";
import { listenGatewayHttpServer } from "./http-listen.js";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => {}));

// mock-isolation: Control retry timing without loading unrelated utility dependencies.
vi.mock("../../utils.js", () => ({ sleep: (ms: number) => sleepMock(ms) }));

function createFakeHttpServer(errors: string[]) {
  class FakeHttpServer extends EventEmitter {
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

    close(cb?: () => void) {
      this.closeCalls += 1;
      setImmediate(() => cb?.());
      return this;
    }
  }

  return new FakeHttpServer();
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
  const onError = vi.fn();
  const onListening = vi.fn();
  server.on("error", onError);
  server.on("listening", onListening);
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
  expect(onError).not.toHaveBeenCalled();
  expect(onListening).not.toHaveBeenCalled();
});

it("retries EADDRINUSE and closes server handle before retry", async () => {
  const fake = createFakeHttpServer(["EADDRINUSE"]);
  await expect(listen(fake)).resolves.toBeUndefined();

  expect(fake.closeCalls).toBe(1);
  expect(sleepMock).toHaveBeenCalledTimes(1);
});

it.each([
  {
    reason: "exhausted retries",
    errors: Array<string>(22).fill("EADDRINUSE"),
    retry: true,
    closes: 20,
  },
  { reason: "disabled retries", errors: ["EADDRINUSE"], retry: false, closes: 0 },
  { reason: "non-EADDRINUSE error", errors: ["EACCES"], retry: true, closes: 0 },
])("wraps $reason as GatewayLockError", async ({ errors, retry, closes }) => {
  const fake = createFakeHttpServer(errors);
  await expect(listen(fake, retry)).rejects.toBeInstanceOf(GatewayLockError);
  expect(fake.closeCalls).toBe(closes);
  if (!retry) {
    expect(sleepMock).not.toHaveBeenCalled();
  }
});
