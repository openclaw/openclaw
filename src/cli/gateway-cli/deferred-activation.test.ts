import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetDeferredGatewayActivationForTest,
  waitForDeferredGatewayActivation,
} from "./deferred-activation.js";

const TOKEN = "activation-secret";
const SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR1"] as const;
type ParkingSignal = (typeof SIGNALS)[number];

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
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForHttp(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      // Listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
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

afterEach(async () => {
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

  it("parks until one authenticated bounded activation", async () => {
    const port = await reserveLoopbackPort();
    const waiting = waitForDeferredGatewayActivation({
      env: {
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: String(port),
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN,
      },
    });
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);

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

  it.each([
    ["missing", {}, 400],
    ["non-string", { activationId: 7 }, 400],
    ["empty", { activationId: "" }, 400],
    ["id too large", { activationId: "a".repeat(257) }, 400],
  ])("rejects %s activation ids and remains parked", async (_name, body, status) => {
    const port = await reserveLoopbackPort();
    const waiting = waitForDeferredGatewayActivation({
      env: {
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: String(port),
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN,
      },
    });
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);
    expect((await postActivate(port, TOKEN, body)).status).toBe(status);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await postActivate(port, TOKEN, { activationId: "cleanup" })).status).toBe(202);
    await expect(waiting).resolves.toEqual({ mode: "activated", activationId: "cleanup" });
  });

  it("rejects a body over 16 KiB and remains parked", async () => {
    const port = await reserveLoopbackPort();
    const waiting = waitForDeferredGatewayActivation({
      env: {
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: String(port),
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN,
      },
    });
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);
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

  it("accepts only one concurrent activation request", async () => {
    const port = await reserveLoopbackPort();
    const waiting = waitForDeferredGatewayActivation({
      env: {
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: String(port),
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN,
      },
    });
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);

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

  it("rejects parking on SIGTERM and removes temporary signal handlers", async () => {
    const signalListeners = captureSignalListeners();
    const port = await reserveLoopbackPort();
    const waiting = waitForDeferredGatewayActivation({
      env: {
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_CONTROL_PORT: String(port),
        OPENCLAW_GATEWAY_DEFERRED_ACTIVATION_TOKEN: TOKEN,
      },
    });
    await waitForHttp(`http://127.0.0.1:${port}/healthz`);

    expect(countAddedSignalListeners(signalListeners)).toEqual({
      SIGTERM: 1,
      SIGINT: 1,
      SIGUSR1: 1,
    });

    const sigterm = findAddedSignalListener("SIGTERM", signalListeners.SIGTERM);
    expect(sigterm).not.toBeNull();
    sigterm?.();

    await expect(waiting).rejects.toThrow("deferred activation interrupted by SIGTERM");
    expect(countAddedSignalListeners(signalListeners)).toEqual({
      SIGTERM: 0,
      SIGINT: 0,
      SIGUSR1: 0,
    });
  });
});
