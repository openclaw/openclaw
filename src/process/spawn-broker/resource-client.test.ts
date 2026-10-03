/**
 * Spawn broker native resource client: the worker-side attachment that owns one broker socket,
 * its retry/startup deadline, target forwarding, and the close handshake.
 * The production endpoint is a private Unix socket (a named pipe on Windows).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachBrokerNativeResource } from "./resource-client.js";
import type { BrokerResourceAttachment, BrokerResourceResponse } from "./resource-protocol.js";
import { createBrokerResourceSocket } from "./resource-socket.js";

type Peer = ReturnType<typeof createBrokerResourceSocket>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

/** A private broker endpoint, mirroring the production platform distinction in host.ts. */
function makeEndpoint() {
  const secret = randomBytes(6).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\oc-br-test-${secret}`;
  }
  const directory = join(tmpdir(), `oc-native-resource-${secret}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "resource.sock");
}

async function brokerEndpoint() {
  const endpoint = makeEndpoint();
  const server: Server = createServer();
  const sockets: Socket[] = [];
  const accepted = new Promise<Socket>((resolve) => {
    server.once("connection", (socket) => {
      sockets.push(socket);
      resolve(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(endpoint, () => {
      resolve();
    });
  });
  cleanups.push(async () => {
    await Promise.all(
      sockets.map(async (socket) => {
        if (socket.closed) {
          return;
        }
        const closed = new Promise<void>((resolve) => {
          socket.once("close", () => {
            resolve();
          });
        });
        socket.destroy();
        await closed;
      }),
    );
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  return { endpoint, accepted };
}

function makeAttachment(
  endpoint: string,
  overrides: Partial<BrokerResourceAttachment> = {},
): BrokerResourceAttachment {
  return {
    endpoint,
    secret: randomBytes(8).toString("hex"),
    generation: 1,
    id: 7,
    moduleUrl: "file:///native-resource.js",
    ownerPort: true,
    startupDeadline: Date.now() + 10_000,
    ...overrides,
  };
}

function makeTarget() {
  const channel = new MessageChannel();
  return { port: channel.port1 as unknown as MessagePort, peer: channel.port2 };
}

function makeOwner(attachment: BrokerResourceAttachment, target: MessagePort) {
  const responses: BrokerResourceResponse[] = [];
  const failures: Error[] = [];
  const owner = attachBrokerNativeResource(
    attachment,
    target,
    (response) => responses.push(response),
    (error) => failures.push(error),
  );
  cleanups.push(async () => owner.dispose());
  return { owner, failures };
}

describe("spawn broker native resource client", () => {
  it("attaches, forwards factory-admitted target input, and closes through the broker", async () => {
    const { endpoint, accepted } = await brokerEndpoint();
    const attachment = makeAttachment(endpoint);
    const target = makeTarget();
    const { owner, failures } = makeOwner(attachment, target.port);

    // The attachment dials the private endpoint; the server accepts that connection.
    const ownerSocket = await accepted;
    const received: unknown[] = [];
    const peer: Peer = createBrokerResourceSocket(ownerSocket, {
      message: (value) => received.push(value),
      close: () => {},
    });

    await vi.waitFor(() =>
      expect(received).toContainEqual({ type: "resource-attach", attachment }),
    );

    // Input arriving before the factory admits ownership is forwarded once it does.
    target.peer.postMessage("early-input", []);

    await peer.send({ type: "resource-ready", id: attachment.id, pid: 42, generation: 1 });

    // A close issued before ownership is admitted waits for initialization instead of failing.
    const closing = owner.close();

    await peer.send({ type: "resource-created", id: attachment.id });
    await vi.waitFor(() =>
      expect(received).toContainEqual({
        type: "resource-target",
        id: attachment.id,
        value: "early-input",
      }),
    );
    await vi.waitFor(() =>
      expect(received.some((value) => (value as { type?: string }).type === "resource-close")).toBe(
        true,
      ),
    );
    const closeRequest = received.find(
      (value): value is { type: "resource-close"; requestId: number } =>
        (value as { type?: string }).type === "resource-close",
    );
    expect(closeRequest).toBeDefined();

    await peer.send({
      type: "resource-closed",
      id: attachment.id,
      requestId: closeRequest?.requestId ?? 0,
    });
    await expect(closing).resolves.toBeUndefined();
    expect(ownerSocket.closed).toBe(false);
    expect(failures).toEqual([]);
  });

  it("forwards input that arrived before another consumer started the port", async () => {
    const { endpoint, accepted } = await brokerEndpoint();
    const attachment = makeAttachment(endpoint);
    const target = makeTarget();
    const { failures } = makeOwner(attachment, target.port);

    const ownerSocket = await accepted;
    const received: unknown[] = [];
    const peer: Peer = createBrokerResourceSocket(ownerSocket, {
      message: (value) => received.push(value),
      close: () => {},
    });
    await vi.waitFor(() =>
      expect(received).toContainEqual({ type: "resource-attach", attachment }),
    );

    // Another consumer of the target port starts it: the port drains queued input before the
    // factory admits ownership, so a listener installed only after admission sees nothing.
    // This probe is that competing consumer: awaiting its dispatch proves the port delivered
    // the input before admission, so the regression cannot pass on code that listens late.
    const dispatched = new Promise<unknown>((resolve) => {
      target.port.once("message", (value) => {
        resolve(value);
      });
    });
    target.peer.postMessage("input-before-start", []);
    target.port.start();
    expect(await dispatched).toBe("input-before-start");

    // The dispatched input is buffered, not forwarded: admission has not happened yet.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(received).toHaveLength(1);

    await peer.send({ type: "resource-ready", id: attachment.id, pid: 1, generation: 1 });
    await peer.send({ type: "resource-created", id: attachment.id });

    await vi.waitFor(() =>
      expect(received).toContainEqual({
        type: "resource-target",
        id: attachment.id,
        value: "input-before-start",
      }),
    );
    expect(failures).toEqual([]);
  });

  it("rejects a response identity that belongs to another attachment", async () => {
    const { endpoint, accepted } = await brokerEndpoint();
    const attachment = makeAttachment(endpoint);
    const target = makeTarget();
    const { failures } = makeOwner(attachment, target.port);

    const ownerSocket = await accepted;
    const peer = createBrokerResourceSocket(ownerSocket, { message: () => {}, close: () => {} });
    await peer.send({ type: "resource-ready", id: attachment.id + 1, pid: 1, generation: 1 });

    await vi.waitFor(() =>
      expect(failures.map((error) => error.message)).toContain(
        "Invalid native resource response identity",
      ),
    );
  });

  it("fails the attachment when the startup deadline passes without readiness", async () => {
    // A broker that accepts the connection but never reports readiness: the deadline is the
    // only failure path, so the socket's own close cannot race the assertion. The connection
    // is real; only the deadline clock is controlled, so a loaded runner cannot expire the
    // timer before the server accepts.
    const { endpoint, accepted } = await brokerEndpoint();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attachment = makeAttachment(endpoint, { startupDeadline: Date.now() + 50 });
    const target = makeTarget();
    const { failures } = makeOwner(attachment, target.port);
    await accepted;

    vi.advanceTimersByTime(60);
    expect(failures.map((error) => error.message)).toContain(
      "Spawn broker readiness deadline exceeded",
    );
  });
});
