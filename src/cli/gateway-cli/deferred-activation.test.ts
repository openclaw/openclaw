import { ServerResponse } from "node:http";
import { createConnection, createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetDeferredGatewayActivationForTest,
  waitForDeferredGatewayActivation,
} from "./deferred-activation.js";

const TOKEN = "activation-secret";
const SIGNALS = ["SIGTERM", "SIGINT"] as const;
type ParkingSignal = (typeof SIGNALS)[number];

function deferredActivationEnv(port: number) {
  return {
    OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: String(port),
    OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN,
  };
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected TCP address"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) {
        return;
      }
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function postActivate(port: number, token: string, body: unknown) {
  return await fetch(`http://127.0.0.1:${port}/activate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openclaw-activation-token": token,
    },
    body: JSON.stringify(body),
  });
}

async function waitForParkedGateway(port: number): Promise<{
  waiting: ReturnType<typeof waitForDeferredGatewayActivation>;
}> {
  const waiting = waitForDeferredGatewayActivation({
    env: deferredActivationEnv(port),
  });
  await waitForHttp(`http://127.0.0.1:${port}/healthz`);
  return { waiting };
}

async function expectLoopbackListenerClosed(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
    } catch {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`expected loopback listener on ${port} to close`);
}

async function expectFreshProcessEquivalentCanReuseControlPort(
  port: number,
  activationId: string,
): Promise<void> {
  await resetDeferredGatewayActivationForTest();
  const { waiting } = await waitForParkedGateway(port);
  expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  expect((await postActivate(port, TOKEN, { activationId })).status).toBe(202);
  await expect(waiting).resolves.toEqual({ mode: "activated", activationId });
}

async function expectSettlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function expectPortReusable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  });
}

async function openPartialHeaderClient(port: number): Promise<{
  destroy: () => void;
  closed: Promise<void>;
}> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  await connected;
  socket.write("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  return {
    destroy: () => socket.destroy(),
    closed,
  };
}

async function sendCompleteActivationThenAbort(port: number, activationId: string): Promise<void> {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
  });
  const body = JSON.stringify({ activationId });
  const request = [
    "POST /activate HTTP/1.1",
    "Host: 127.0.0.1",
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
    `x-openclaw-activation-token: ${TOKEN}`,
    "",
    body,
  ].join("\r\n");

  await connected;
  await new Promise<void>((resolve, reject) => {
    socket.write(request, (error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  if (typeof socket.resetAndDestroy === "function") {
    socket.resetAndDestroy();
  } else {
    socket.destroy();
  }
  await closed;
}

async function sendRawHttpRequest(
  port: number,
  request: string,
): Promise<{
  closedWithError: boolean;
  responseText: string;
}> {
  const socket = createConnection({ host: "127.0.0.1", port });
  const responseChunks: Buffer[] = [];
  socket.on("data", (chunk) => {
    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  socket.on("error", () => {});
  const connected = new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const closed = new Promise<boolean>((resolve) => {
    socket.once("close", (hadError) => resolve(hadError));
  });

  await connected;
  await new Promise<void>((resolve, reject) => {
    socket.end(request, (error?: Error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  return {
    closedWithError: await closed,
    responseText: Buffer.concat(responseChunks).toString("utf8"),
  };
}

function captureSignalListeners() {
  return Object.fromEntries(
    SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))]),
  ) as Record<ParkingSignal, Set<(...args: unknown[]) => void>>;
}

function findAddedSignalListener(
  signal: ParkingSignal,
  existing: Set<(...args: unknown[]) => void>,
): (() => void) | null {
  const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
  for (let index = listeners.length - 1; index >= 0; index -= 1) {
    const listener = listeners[index];
    if (listener && !existing.has(listener)) {
      return listener as () => void;
    }
  }
  return null;
}

function countAddedSignalListeners(
  existing: Record<ParkingSignal, Set<(...args: unknown[]) => void>>,
): Record<ParkingSignal, number> {
  return Object.fromEntries(
    SIGNALS.map((signal) => [
      signal,
      (process.listeners(signal) as Array<(...args: unknown[]) => void>).filter(
        (listener) => !existing[signal].has(listener),
      ).length,
    ]),
  ) as Record<ParkingSignal, number>;
}

function countAddedListenersForSignal(
  signal: NodeJS.Signals,
  existing: Set<(...args: unknown[]) => void>,
): number {
  return (process.listeners(signal) as Array<(...args: unknown[]) => void>).filter(
    (listener) => !existing.has(listener),
  ).length;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await resetDeferredGatewayActivationForTest();
});

describe("waitForDeferredGatewayActivation", () => {
  it("is disabled only when both control variables are absent", async () => {
    await expect(waitForDeferredGatewayActivation({ env: {} })).resolves.toEqual({
      mode: "disabled",
    });
  });

  it("rejects a half-configured control surface", async () => {
    await expect(
      waitForDeferredGatewayActivation({
        env: { OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN },
      }),
    ).rejects.toThrow("control port and token must be configured together");
  });

  it.each(["0", "65536", "NaN"])("rejects invalid control port %s", async (port) => {
    await expect(
      waitForDeferredGatewayActivation({
        env: {
          OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: port,
          OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN,
        },
      }),
    ).rejects.toThrow("invalid deferred activation control port");
  });

  it.each(["", " \t "])(
    "rejects %j control token before preload or listener bind",
    async (controlToken) => {
      const port = await reserveLoopbackPort();
      const preload = vi.fn(async () => undefined);

      await expect(
        waitForDeferredGatewayActivation({
          env: {
            OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: String(port),
            OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: controlToken,
          },
          preload,
        }),
      ).rejects.toThrow("deferred activation control token must be non-empty");

      expect(preload).not.toHaveBeenCalled();
      await expectPortReusable(port);
    },
  );

  it("parks until one authenticated bounded activation", async () => {
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);

    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
    expect((await postActivate(port, "wrong", { activationId: "a" })).status).toBe(401);

    const accepted = await postActivate(port, TOKEN, { activationId: "activation-1" });
    expect(accepted.status).toBe(202);
    await expect(waiting).resolves.toEqual({
      mode: "activated",
      activationId: "activation-1",
    });
  });

  it("resolves accepted activation promptly even when a slow partial-header socket is parked", async () => {
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);
    const slowClient = await openPartialHeaderClient(port);

    try {
      const accepted = await postActivate(port, TOKEN, { activationId: "activation-slow-socket" });
      expect(accepted.status).toBe(202);
      await expect(accepted.json()).resolves.toEqual({
        status: "accepted",
        activationId: "activation-slow-socket",
      });
      await expect(expectSettlesWithin(waiting, 1_000)).resolves.toEqual({
        mode: "activated",
        activationId: "activation-slow-socket",
      });
      await expect(expectSettlesWithin(slowClient.closed, 1_000)).resolves.toBeUndefined();
      await expectLoopbackListenerClosed(port);
      await expectFreshProcessEquivalentCanReuseControlPort(port, "restart-after-slow-socket");
    } finally {
      slowClient.destroy();
    }
  });

  it("commits the first valid activation even when the client aborts after sending the full request", async () => {
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);

    await sendCompleteActivationThenAbort(port, "activation-client-abort");

    await expect(expectSettlesWithin(waiting, 1_000)).resolves.toEqual({
      mode: "activated",
      activationId: "activation-client-abort",
    });
    await expectLoopbackListenerClosed(port);
    await expectFreshProcessEquivalentCanReuseControlPort(port, "restart-after-client-abort");
  });

  it.each([
    ["missing", {}, 400],
    ["non-string", { activationId: 7 }, 400],
    ["empty", { activationId: "" }, 400],
    ["id too large", { activationId: "a".repeat(257) }, 400],
  ])("rejects %s activation ids and remains parked", async (_name, body, status) => {
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);

    expect((await postActivate(port, TOKEN, body)).status).toBe(status);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await postActivate(port, TOKEN, { activationId: "cleanup" })).status).toBe(202);
    await expect(waiting).resolves.toEqual({ mode: "activated", activationId: "cleanup" });
  });

  it("rejects a body over 16 KiB and remains parked", async () => {
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);

    const response = await fetch(`http://127.0.0.1:${port}/activate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openclaw-activation-token": TOKEN,
      },
      body: JSON.stringify({ activationId: "a".repeat(17 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await postActivate(port, TOKEN, { activationId: "cleanup" })).status).toBe(202);
    await expect(waiting).resolves.toEqual({ mode: "activated", activationId: "cleanup" });
  });

  it("rejects malformed absolute-form request targets without closing the control listener", async () => {
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);
    const activationBody = JSON.stringify({ activationId: "ignored-malformed-target" });

    const malformedResponse = await sendRawHttpRequest(
      port,
      [
        "POST http://%zz/activate HTTP/1.1",
        "Host: 127.0.0.1",
        "content-type: application/json",
        `content-length: ${Buffer.byteLength(activationBody)}`,
        `x-openclaw-activation-token: ${TOKEN}`,
        "Connection: close",
        "",
        activationBody,
      ].join("\r\n"),
    );

    expect(malformedResponse.closedWithError).toBe(false);
    expect(malformedResponse.responseText).toContain("HTTP/1.1 400 Bad Request");
    expect(malformedResponse.responseText).toContain('{"error":"invalid request target"}');
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);

    const accepted = await postActivate(port, TOKEN, {
      activationId: "activation-after-malformed-target",
    });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({
      status: "accepted",
      activationId: "activation-after-malformed-target",
    });
    await expect(waiting).resolves.toEqual({
      mode: "activated",
      activationId: "activation-after-malformed-target",
    });
  });

  it("accepts only one concurrent activation request", async () => {
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);

    const requests = await Promise.allSettled([
      postActivate(port, TOKEN, { activationId: "activation-1" }),
      postActivate(port, TOKEN, { activationId: "activation-2" }),
    ]);
    const acceptedResponses = requests.filter(
      (request): request is PromiseFulfilledResult<Response> =>
        request.status === "fulfilled" && request.value.status === 202,
    );

    expect(acceptedResponses).toHaveLength(1);
    expect(
      requests.filter((request) => request.status === "rejected" || request.value.status !== 202),
    ).toHaveLength(1);

    const acceptedBody = (await acceptedResponses[0].value.json()) as {
      activationId: string;
    };
    await expect(waiting).resolves.toEqual({
      mode: "activated",
      activationId: acceptedBody.activationId,
    });
  });

  it("parks only SIGTERM and SIGINT temporary listeners", async () => {
    const signalListeners = captureSignalListeners();
    const sigusr1Listeners = new Set(
      process.listeners("SIGUSR1") as Array<(...args: unknown[]) => void>,
    );
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);

    try {
      expect(countAddedSignalListeners(signalListeners)).toEqual({
        SIGTERM: 1,
        SIGINT: 1,
      });
      expect(countAddedListenersForSignal("SIGUSR1", sigusr1Listeners)).toBe(0);
      expect((await postActivate(port, TOKEN, { activationId: "cleanup-signals" })).status).toBe(
        202,
      );
      await expect(waiting).resolves.toEqual({
        mode: "activated",
        activationId: "cleanup-signals",
      });
    } finally {
      await resetDeferredGatewayActivationForTest();
    }
  });

  it("removes temporary SIGTERM/SIGINT listeners synchronously before writing the accepted 202", async () => {
    const signalListeners = captureSignalListeners();
    const originalWriteHead = Object.getOwnPropertyDescriptor(
      ServerResponse.prototype,
      "writeHead",
    )?.value;
    if (originalWriteHead === undefined) {
      throw new Error("expected ServerResponse.writeHead");
    }
    const writeHeadSpy = vi
      .spyOn(ServerResponse.prototype, "writeHead")
      .mockImplementation(function (
        ...args: Parameters<typeof ServerResponse.prototype.writeHead>
      ) {
        if (args[0] === 202) {
          expect(countAddedSignalListeners(signalListeners)).toEqual({
            SIGTERM: 0,
            SIGINT: 0,
          });
        }
        return Reflect.apply(originalWriteHead, this, args);
      });
    const port = await reserveLoopbackPort();
    const { waiting } = await waitForParkedGateway(port);

    try {
      expect(countAddedSignalListeners(signalListeners)).toEqual({
        SIGTERM: 1,
        SIGINT: 1,
      });

      const accepted = await postActivate(port, TOKEN, {
        activationId: "cleanup-before-accepted-response",
      });
      expect(accepted.status).toBe(202);
      expect(countAddedSignalListeners(signalListeners)).toEqual({
        SIGTERM: 0,
        SIGINT: 0,
      });
      await expect(waiting).resolves.toEqual({
        mode: "activated",
        activationId: "cleanup-before-accepted-response",
      });
    } finally {
      writeHeadSpy.mockRestore();
    }
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "re-signals %s only after cleanup and listener close, even with a slow parked socket",
    async (signal) => {
      const signalListeners = captureSignalListeners();
      const killPortReuse: { current: Promise<void> | null } = { current: null };
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid, resentSignal) => {
        expect(pid).toBe(process.pid);
        expect(resentSignal).toBe(signal);
        expect(countAddedSignalListeners(signalListeners)).toEqual({
          SIGTERM: 0,
          SIGINT: 0,
        });
        killPortReuse.current = expectPortReusable(port);
        return true;
      }) as typeof process.kill);
      const port = await reserveLoopbackPort();
      const { waiting } = await waitForParkedGateway(port);
      const slowClient = await openPartialHeaderClient(port);

      try {
        expect(countAddedSignalListeners(signalListeners)).toEqual({
          SIGTERM: 1,
          SIGINT: 1,
        });

        const addedSignalListener = findAddedSignalListener(signal, signalListeners[signal]);
        expect(addedSignalListener).not.toBeNull();
        addedSignalListener?.();

        await expect(waiting).rejects.toThrow(`deferred activation interrupted by ${signal}`);
        expect(killSpy).toHaveBeenCalledWith(process.pid, signal);
        await expect(expectSettlesWithin(slowClient.closed, 1_000)).resolves.toBeUndefined();
        await expectLoopbackListenerClosed(port);
        await expect(killPortReuse.current).resolves.toBeUndefined();
        expect(countAddedSignalListeners(signalListeners)).toEqual({
          SIGTERM: 0,
          SIGINT: 0,
        });
        await expectFreshProcessEquivalentCanReuseControlPort(port, `restart-${signal}`);
      } finally {
        slowClient.destroy();
      }
    },
  );
});
