import { once } from "node:events";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { serialize } from "node:v8";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { MAX_PENDING_BYTES } from "./ipc.js";
import { createBrokerNativeResourceServer } from "./resource-server.js";
import { createBrokerResourceSocket } from "./resource-socket.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function socketPair() {
  const reservation = await reserveTestPortListener({
    offsets: [0],
    createListener: () => createServer(),
  });
  const sockets: Socket[] = [];
  onTestFinished(async () => {
    await Promise.all(
      sockets
        .filter((socket) => !socket.closed)
        .map(
          (socket) =>
            new Promise<void>((resolve) => {
              socket.once("close", resolve);
              socket.destroy();
            }),
        ),
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

function recordSocket(socket: Socket, observe: (messages: unknown[]) => void = () => {}) {
  const closed = createDeferredCore<Error | undefined>();
  const messages: unknown[] = [];
  const close = vi.fn(closed.resolve);
  const transport = createBrokerResourceSocket(socket, {
    message: (value) => {
      messages.push(value);
      observe(messages);
    },
    close,
  });
  return { closed: closed.promise, messages, close, transport };
}

it("reassembles split and large messages in order through bidirectional traffic and peer EOF", async () => {
  const { client, peer } = await socketPair();
  const completed = createDeferredCore();
  const {
    closed,
    close,
    messages,
    transport: first,
  } = recordSocket(client, (values) => {
    if (values.length === 6) {
      completed.resolve();
    }
  });
  const bytes = Buffer.concat([packet("first"), packet(undefined), packet({ last: true })]);
  for (const part of [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)]) {
    const received = once(client, "data");
    await new Promise<void>((resolve, reject) => {
      peer.write(part, (error) => (error ? reject(error) : resolve()));
    });
    await received;
  }
  expect(messages).toEqual(["first", undefined, { last: true }]);
  const second = createBrokerResourceSocket(peer, {
    message: (value) => void second.send(value).catch(completed.reject),
    close: (error) => error && completed.reject(error),
  });
  const large = { bytes: Buffer.alloc(2 * 1024 * 1024 + 17, 73), nested: { count: 42n } };
  await Promise.all([first.send(large), first.send(undefined), first.send("after")]);
  await awaitGateBeforeSettlement(completed.promise, closed, "Socket closed before all replies");
  expect(messages.slice(3)).toEqual([{ ...large, bytes: expect.any(Buffer) }, undefined, "after"]);
  const received = messages[3];
  if (!received || typeof received !== "object" || !("bytes" in received)) {
    throw new Error("Missing echoed broker payload");
  }
  // Compare every byte without treating the multi-megabyte Buffer as object properties.
  expect(Buffer.isBuffer(received.bytes) && received.bytes.equals(large.bytes)).toBe(true);
  peer.end();
  expect(await closed).toBeUndefined();
  await expect(first.send("too late")).rejects.toThrow("socket closed");
  first.close();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["zero", "oversized", "truncated"] as const)(
  "rejects a %s byte frame without publishing a resource message",
  async (kind) => {
    const { client, peer } = await socketPair();
    const { closed, messages, transport } = recordSocket(client);
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(kind === "zero" ? 0 : kind === "oversized" ? MAX_PENDING_BYTES + 1 : 8);
    peer.end(bytes);
    expect(await closed).toBeInstanceOf(Error);
    expect(messages).toEqual([]);
    await expect(transport.send("after failure")).rejects.toThrow();
  },
);

it("rejects queued writes when the peer closes without reading them", async () => {
  const { client, peer } = await socketPair();
  peer.pause();
  const { closed, transport } = recordSocket(client);
  const writes = Promise.allSettled(
    [1, 2, 3].map((id) => transport.send({ id, bytes: Buffer.alloc(8 * 1024 * 1024) })),
  );
  peer.destroy();
  await closed;
  expect((await writes).map((result) => result.status)).toEqual(Array(3).fill("rejected"));
});

it("joins the same native close after transport loss instead of abandoning or duplicating it", async () => {
  const created = createDeferredCore();
  const entered = createDeferredCore();
  const released = createDeferredCore();
  const close = vi.fn(async () => {
    entered.resolve();
    await released.promise;
  });
  const receive = vi.fn(() => {
    throw new Error("owner callback refused");
  });
  vi.stubGlobal("__openclawResourceRetirementFixture", { close, receive });
  const connected = Object.getOwnPropertyDescriptor(process, "connected");
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  let resource: Awaited<ReturnType<typeof createBrokerNativeResourceServer>> | undefined =
    undefined;
  onTestFinished(async () => {
    released.resolve();
    try {
      await resource?.close();
    } finally {
      vi.unstubAllGlobals();
      if (connected) {
        Object.defineProperty(process, "connected", connected);
      } else {
        Reflect.deleteProperty(process, "connected");
      }
    }
  });
  // openclaw-temp-dir: short Unix socket paths also work under a deeply nested TMPDIR.
  const directory = tempDirs.make("oc-r-", process.platform === "win32" ? undefined : "/tmp");
  const auth = {
    endpoint:
      process.platform === "win32"
        ? "\\\\.\\pipe\\" + path.basename(directory)
        : path.join(directory, "s"),
    secret: "synthetic-resource-secret",
    generation: 1,
  };
  const responses: string[] = [];
  resource = await createBrokerNativeResourceServer({
    ...auth,
    canAdmit: () => true,
    reportParent: async ({ type }) => {
      responses.push(type);
      if (type === "resource-created") {
        created.resolve();
      }
    },
  });
  const { transport, closed } = recordSocket(connect(auth.endpoint));
  await transport.send({
    type: "resource-attach",
    attachment: {
      ...auth,
      id: 1,
      ownerPort: true,
      moduleUrl:
        "data:text/javascript," +
        encodeURIComponent(
          "export function createNativeWorkerResource(_target,_input,owner){const fixture=globalThis.__openclawResourceRetirementFixture;owner.on('message',fixture.receive);return fixture;}",
        ),
    },
  });
  await created.promise;
  const request = { type: "resource-owner", id: 1, sequence: 1, value: "request" } as const;
  resource.receive(request);
  await transport.send(request);
  await transport.send({ type: "resource-close", id: 1, requestId: 1 });
  await entered.promise;
  expect(receive).toHaveBeenCalledOnce();
  expect(responses).toContain("resource-owner-rejected");
  expect(responses).not.toContain("resource-owner-received");
  resource.disconnect();
  const settled = vi.fn();
  const closing = resource.close().then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  released.resolve();
  await closing;
  await closed;
  expect(resource.size).toBe(0);
  expect(close).toHaveBeenCalledOnce();
});
