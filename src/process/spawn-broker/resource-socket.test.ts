import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import { serialize } from "node:v8";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { MAX_PENDING_BYTES } from "./ipc.js";
import { createBrokerResourceSocket } from "./resource-socket.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function socketPair() {
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () => createServer(),
  });
  const sockets: Socket[] = [];
  cleanups.push(async () => {
    await Promise.all(
      sockets.map(async (socket) => {
        if (socket.closed) {
          return;
        }
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
        });
        socket.destroy();
        await closed;
      }),
    );
    await reservation.releaseListener();
    await reservation.claim.release();
  });
  const accepted = new Promise<Socket>((resolve) => {
    reservation.listener.once("connection", (socket) => {
      sockets.push(socket);
      resolve(socket);
    });
  });
  const client = connect(reservation.claim.port, "127.0.0.1");
  sockets.push(client);
  await once(client, "connect");
  return { client, peer: await accepted };
}

function packet(value: unknown) {
  const payload = serialize({ value });
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

describe("spawn broker resource socket", () => {
  it("reassembles large broker messages in order and preserves undefined in both directions", async () => {
    const { client, peer } = await socketPair();
    const completed = createDeferredCore();
    const messages: unknown[] = [];
    const first = createBrokerResourceSocket(client, {
      message: (value) => {
        messages.push(value);
        if (messages.length === 3) {
          completed.resolve();
        }
      },
      close: (error) => error && completed.reject(error),
    });
    const second = createBrokerResourceSocket(peer, {
      message: (value) => void second.send(value).catch(completed.reject),
      close: (error) => error && completed.reject(error),
    });
    const large = { bytes: Buffer.alloc(2 * 1024 * 1024 + 17, 73), nested: { count: 42n } };
    await Promise.all([first.send(large), first.send(undefined), first.send("after")]);
    await completed.promise;
    expect(messages).toEqual([large, undefined, "after"]);
  });

  it("accepts split headers and coalesced records, then reports actual peer EOF once", async () => {
    const { client, peer } = await socketPair();
    const closed = createDeferredCore<Error | undefined>();
    const messages: unknown[] = [];
    let closes = 0;
    const transport = createBrokerResourceSocket(client, {
      message: (value) => messages.push(value),
      close: (error) => {
        closes++;
        closed.resolve(error);
      },
    });
    const bytes = Buffer.concat([packet("first"), packet(undefined), packet({ last: true })]);
    for (const part of [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)]) {
      const received = once(client, "data");
      await new Promise<void>((resolve, reject) => {
        peer.write(part, (error) => (error ? reject(error) : resolve()));
      });
      await received;
    }
    peer.end();
    expect(await closed.promise).toBeUndefined();
    expect(messages).toEqual(["first", undefined, { last: true }]);
    await expect(transport.send("too late")).rejects.toThrow("socket closed");
    transport.close();
    expect(closes).toBe(1);
  });

  it.each(["zero", "oversized", "truncated"] as const)(
    "rejects a %s byte frame without publishing a resource message",
    async (kind) => {
      const { client, peer } = await socketPair();
      const closed = createDeferredCore<Error | undefined>();
      const messages: unknown[] = [];
      const transport = createBrokerResourceSocket(client, {
        message: (value) => messages.push(value),
        close: closed.resolve,
      });
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(kind === "zero" ? 0 : kind === "oversized" ? MAX_PENDING_BYTES + 1 : 8);
      peer.end(bytes);
      expect(await closed.promise).toBeInstanceOf(Error);
      expect(messages).toEqual([]);
      await expect(transport.send("after failure")).rejects.toThrow();
    },
  );

  it("rejects queued writes when the peer closes without reading them", async () => {
    const { client, peer } = await socketPair();
    peer.pause();
    const closed = createDeferredCore();
    const transport = createBrokerResourceSocket(client, {
      message: () => {},
      close: () => closed.resolve(),
    });
    const writes = Promise.allSettled(
      [1, 2, 3].map((id) => transport.send({ id, bytes: Buffer.alloc(8 * 1024 * 1024) })),
    );
    peer.destroy();
    await closed.promise;
    expect((await writes).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
  });
});
