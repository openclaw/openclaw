import { once } from "node:events";
import { createServer, IncomingMessage, request as httpRequest } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GatewayConnectionWork } from "../server-connection-work.js";
import { OPERATOR_HTTP_LIMITS } from "./operator-http-contract.js";
import type { OperatorHttpPollResponse } from "./operator-http-contract.js";
import type { GatewayOperatorHttpIngress } from "./operator-http-ingress.js";
import { GatewayOperatorHttpTransport } from "./operator-http-transport.js";

describe("operator HTTP delivery lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  function createTransport() {
    const request = new IncomingMessage(new Socket());
    const ingress: GatewayOperatorHttpIngress = {
      request,
      binding: "test-ingress",
      attribution: {
        kind: "direct-local",
        clientIp: "127.0.0.1",
        rateLimit: { subject: { key: "127.0.0.1" }, resetOnSuccess: true },
      },
      isCurrent: () => true,
    };
    const remove = vi.fn();
    const transport = new GatewayOperatorHttpTransport(ingress, remove);
    transport.bindOwner({
      getClient: () => null,
      isClosed: () => false,
      close: transport.close.bind(transport),
    });
    return { transport, ingress, remove };
  }

  test.each(["expiry", "terminate"])(
    "settles an undelivered terminal callback on %s and drains tracked work",
    async (mode) => {
      vi.useFakeTimers();
      const { transport, remove } = createTransport();
      const work = new GatewayConnectionWork();
      const callback = vi.fn();
      const delivered = new Promise<void>((resolve) => {
        transport.sendWithContext(
          JSON.stringify({ type: "res", id: "connect", ok: false }),
          (error) => {
            callback(error);
            resolve();
          },
          { rejectedHandshake: true },
        );
      });
      void work.track(() => delivered);
      transport.close(1008, "handshake rejected");
      expect(callback).not.toHaveBeenCalled();
      if (mode === "expiry") {
        await vi.advanceTimersByTimeAsync(OPERATOR_HTTP_LIMITS.idleTimeoutMs);
      } else {
        transport.terminate();
      }
      await work.drain();
      expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      expect(remove).toHaveBeenCalledOnce();
      expect(transport.bufferedAmount).toBe(0);
    },
  );

  test("removes once without retaining a timer when a failed delivery terminates reentrantly", async () => {
    vi.useFakeTimers();
    const { transport, remove } = createTransport();
    const callback = vi.fn(() => transport.terminate());
    transport.send('{"type":"event","event":"tick"}', callback);
    transport.close(4001, "authority changed");
    transport.terminate();
    await vi.advanceTimersByTimeAsync(OPERATOR_HTTP_LIMITS.idleTimeoutMs);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(remove).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("reports explicit resync and fails every callback when frame capacity is exceeded", () => {
    const { transport } = createTransport();
    const callbacks = Array.from({ length: 257 }, () => vi.fn());
    const closed = vi.fn();
    transport.on("close", closed);
    try {
      for (const callback of callbacks) {
        transport.send('{"type":"event","event":"tick"}', callback);
      }
      expect(transport.readyState).toBe(3);
      expect(closed).toHaveBeenCalledExactlyOnceWith(1009, expect.any(Buffer));
      expect(transport.bufferedAmount).toBe(0);
      for (const callback of callbacks) {
        expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      }
    } finally {
      transport.terminate();
    }
  });

  test("uses response finish for delivery, retains replay until ACK, and caps poll batches", async () => {
    const { transport, ingress } = createTransport();
    const callback = vi.fn();
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store");
      void transport.pollFrames(response, ingress, 0);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener");
    }
    const poll = async (): Promise<OperatorHttpPollResponse> =>
      await (
        await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(5000) })
      ).json();
    try {
      for (let index = 0; index < 65; index++) {
        transport.send(
          JSON.stringify({ type: "event", event: "tick", seq: 1000 + index }),
          callback,
        );
      }
      expect(callback).not.toHaveBeenCalled();
      expect(transport.acknowledge(1)).toBe(false);
      const first = await poll();
      expect(first.frames).toHaveLength(64);
      expect(first.frames[0]).toMatchObject({ cursor: 1, frame: { seq: 1000 } });
      expect(callback).toHaveBeenCalledTimes(64);
      expect((await poll()).frames).toEqual(first.frames);
      expect(callback).toHaveBeenCalledTimes(64);
      expect(transport.acknowledge(64)).toBe(true);
      expect(transport.acknowledge(63)).toBe(false);
      expect((await poll()).frames).toEqual([
        { cursor: 65, frame: { type: "event", event: "tick", seq: 1064 } },
      ]);
      expect(callback).toHaveBeenCalledTimes(65);
      expect(transport.acknowledge(65)).toBe(true);
      expect(transport.bufferedAmount).toBe(0);
    } finally {
      transport.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test("keeps aborted writes retryable without reporting delivery, then bounds retries", async () => {
    const { transport, ingress } = createTransport();
    const callback = vi.fn();
    let pollCompleted = Promise.resolve(false);
    const server = createServer((request, response) => {
      pollCompleted = transport.pollFrames(response, ingress, 0);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP listener");
    }
    try {
      transport.send(JSON.stringify({ payload: "x".repeat(8 * 1024 * 1024) }), callback);
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise<void>((resolve, reject) => {
          const request = httpRequest({ host: "127.0.0.1", port: address.port }, (response) => {
            response.pause();
            request.destroy();
            resolve();
          });
          request.once("error", reject);
          request.end();
        });
        await pollCompleted;
        if (attempt < 2) {
          expect(callback).not.toHaveBeenCalled();
          expect(transport.readyState).toBe(1);
        }
      }
      expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      expect(transport.readyState).toBe(3);
    } finally {
      transport.terminate();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
