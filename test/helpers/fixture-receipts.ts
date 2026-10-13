import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BroadcastChannel } from "node:worker_threads";

/**
 * Socket clients observe product-spawned children; broadcast clients observe worker threads
 * in the test process. Receipts are not ordered with the fixture's other output or exit.
 * A wait raced against an operation the child's replies can settle must confirm against a durable
 * record the child writes before replying.
 * Socket close represents process exit only because Node sockets are close-on-exec
 * (descendants do not inherit them) and the client never ends its socket.
 * Broadcast clients do not support release or exit observation.
 */
export type FixtureReceiptChannel = {
  readonly endpoint: string;
  readonly broadcastName: string;
  waitFor(source: string, text: string, count?: number): Promise<void>;
  waitForExit(source: string): Promise<void>;
  release(source: string, token: string): void;
  close(): Promise<void>;
};

type ExitWaiter = {
  source: string;
  resolve(): void;
  reject(error: Error): void;
};

type Waiter = {
  source: string;
  text: string;
  count: number;
  resolve(): void;
  reject(error: Error): void;
};

/** Test-owned side channel for children whose process and stdio belong to the product. */
export async function openFixtureReceiptChannel(): Promise<FixtureReceiptChannel> {
  const tempRoot = os.tmpdir();
  const socketRoot =
    Buffer.byteLength(path.join(tempRoot, "oc-r-XXXXXX", "s")) > 100 ? "/tmp" : tempRoot;
  // openclaw-temp-dir: allow /tmp fallback for nested suites' deep TMPDIRs;
  // Unix socket paths are capped at 108 bytes on Linux and 104 on macOS.
  const directory =
    process.platform === "win32" ? undefined : await fs.mkdtemp(path.join(socketRoot, "oc-r-"));
  const endpoint = directory
    ? path.join(directory, "s")
    : `\\\\.\\pipe\\openclaw-fixture-receipts-${process.pid}-${randomUUID()}`;
  const broadcastName = `openclaw-fixture-receipts:${randomUUID()}`;
  const broadcast = new BroadcastChannel(broadcastName);
  const receipts = new Map<string, string[]>();
  const waiters = new Set<Waiter>();
  const sockets = new Set<net.Socket>();
  const connections = new Map<string, Set<net.Socket>>();
  const releases = new Map<string, Set<string>>();
  const exitWaiters = new Set<ExitWaiter>();
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;

  const received = (waiter: Pick<Waiter, "source" | "text" | "count">) =>
    (receipts.get(waiter.source) ?? []).filter((line) => line.includes(waiter.text)).length >=
    waiter.count;
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of waiters) {
      waiter.reject(failure);
    }
    waiters.clear();
    for (const waiter of exitWaiters) {
      waiter.reject(failure);
    }
    exitWaiters.clear();
  };
  const associate = (socket: net.Socket, source: string) => {
    const associated = connections.get(source) ?? new Set<net.Socket>();
    if (associated.has(socket)) {
      return;
    }
    associated.add(socket);
    connections.set(source, associated);
    for (const token of releases.get(source) ?? []) {
      socket.write(JSON.stringify({ release: token }) + "\n");
    }
  };
  const record = (receipt: unknown, socket?: net.Socket) => {
    if (
      socket &&
      typeof receipt === "object" &&
      receipt !== null &&
      "announce" in receipt &&
      typeof receipt.announce === "string" &&
      Object.keys(receipt).length === 1
    ) {
      associate(socket, receipt.announce);
      return;
    }
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("source" in receipt) ||
      typeof receipt.source !== "string" ||
      !("line" in receipt) ||
      typeof receipt.line !== "string"
    ) {
      throw new Error("expected { source: string, line: string }");
    }
    if (socket) {
      associate(socket, receipt.source);
    }
    const lines = receipts.get(receipt.source) ?? [];
    lines.push(receipt.line);
    receipts.set(receipt.source, lines);
    for (const waiter of waiters) {
      if (waiter.source === receipt.source && received(waiter)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };
  broadcast.addEventListener("message", ({ data }: { data: unknown }) => {
    if (failure) {
      return;
    }
    try {
      record(data);
    } catch (cause) {
      fail(new Error("Malformed fixture receipt: broadcast message", { cause }));
    }
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      if (failure) {
        return;
      }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const receipt: unknown = JSON.parse(line);
          record(receipt, socket);
        } catch (cause) {
          fail(new Error(`Malformed fixture receipt: ${line}`, { cause }));
          return;
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      if (buffer && !closing) {
        fail(new Error(`Malformed fixture receipt: connection closed before newline: ${buffer}`));
      }
      for (const associated of connections.values()) {
        associated.delete(socket);
      }
      if (!failure && !closing) {
        for (const waiter of exitWaiters) {
          if (connections.get(waiter.source)?.size === 0) {
            exitWaiters.delete(waiter);
            waiter.resolve();
          }
        }
      }
    });
  });
  server.on("error", fail);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    broadcast.close();
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }

  return {
    endpoint,
    broadcastName,
    waitFor(source, text, count = 1) {
      if (failure) {
        return Promise.reject(failure);
      }
      if (closing) {
        return Promise.reject(
          new Error(`Fixture receipt channel closed while waiting for ${text} in ${source}`),
        );
      }
      // Retain earlier receipts; only the owning test's signal supplies a timeout.
      if (received({ source, text, count })) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        waiters.add({ source, text, count, resolve, reject });
      });
    },
    waitForExit(source) {
      if (failure) {
        return Promise.reject(failure);
      }
      if (closing) {
        return Promise.reject(
          new Error(`Fixture receipt channel closed while waiting for exit in ${source}`),
        );
      }
      if (connections.get(source)?.size === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        exitWaiters.add({ source, resolve, reject });
      });
    },
    release(source, token) {
      if (failure) {
        throw failure;
      }
      if (closing) {
        throw new Error(`Fixture receipt channel closed while releasing ${source}`);
      }
      const tokens = releases.get(source) ?? new Set<string>();
      tokens.add(token);
      releases.set(source, tokens);
      for (const socket of connections.get(source) ?? []) {
        socket.write(JSON.stringify({ release: token }) + "\n");
      }
    },
    close() {
      closing ??= (async () => {
        broadcast.close();
        for (const waiter of waiters) {
          waiter.reject(
            new Error(
              `Fixture receipt channel closed while waiting for ${waiter.text} in ${waiter.source}`,
            ),
          );
        }
        waiters.clear();
        for (const waiter of exitWaiters) {
          waiter.reject(
            new Error(`Fixture receipt channel closed while waiting for exit in ${waiter.source}`),
          );
        }
        exitWaiters.clear();
        for (const socket of sockets) {
          socket.destroy();
        }
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        } finally {
          if (directory) {
            await fs.rm(directory, { recursive: true, force: true });
          }
        }
      })();
      return closing;
    },
  };
}

export function fixtureReceiptClientSource(endpoint: string): string {
  return `import { createConnection as connectFixtureReceipts } from "node:net";
let fixtureReceiptSocket;
let fixtureReleaseBuffer = "";
let fixtureReleaseFailure;
const fixtureAnnounced = new Set();
const fixtureReleased = new Set();
const fixtureReleaseWaiters = new Set();
function connectReceipts() {
  if (!fixtureReceiptSocket) {
    fixtureReceiptSocket = connectFixtureReceipts(${JSON.stringify(endpoint)});
    const fail = (error) => {
      fixtureReleaseFailure ??= error;
      for (const waiter of fixtureReleaseWaiters) waiter.reject(fixtureReleaseFailure);
      fixtureReleaseWaiters.clear();
      fixtureReceiptSocket.unref();
    };
    fixtureReceiptSocket.on("error", fail);
    fixtureReceiptSocket.on("close", () => fail(new Error("Fixture receipt channel closed")));
    fixtureReceiptSocket.setEncoding("utf8");
    fixtureReceiptSocket.on("data", (chunk) => {
      fixtureReleaseBuffer += chunk;
      let newline;
      while ((newline = fixtureReleaseBuffer.indexOf("\\n")) >= 0) {
        const message = JSON.parse(fixtureReleaseBuffer.slice(0, newline));
        fixtureReleaseBuffer = fixtureReleaseBuffer.slice(newline + 1);
        fixtureReleased.add(message.release);
        for (const waiter of fixtureReleaseWaiters) {
          if (waiter.token === message.release) {
            fixtureReleaseWaiters.delete(waiter);
            waiter.resolve();
          }
        }
      }
      if (fixtureReleaseWaiters.size === 0) fixtureReceiptSocket.unref();
    });
    // Observation alone must never keep a product-owned fixture alive.
    fixtureReceiptSocket.unref();
  }
  return fixtureReceiptSocket;
}
function sendReceipt(source, line) {
  connectReceipts().write(JSON.stringify({ source, line }) + "\\n");
}
function announce(source) {
  if (!fixtureAnnounced.has(source)) {
    fixtureAnnounced.add(source);
    connectReceipts().write(JSON.stringify({ announce: source }) + "\\n");
  }
}
function awaitRelease(source, token) {
  announce(source);
  if (fixtureReleaseFailure) return Promise.reject(fixtureReleaseFailure);
  if (fixtureReleased.has(token)) return Promise.resolve();
  // Only a pending host release owns fixture liveness.
  fixtureReceiptSocket.ref();
  return new Promise((resolve, reject) => {
    fixtureReleaseWaiters.add({ token, resolve, reject });
  });
}`;
}

/** POSIX release for shell fixtures and synchronously blocked Node event loops. */
export async function openFixtureReleaseFifo(
  directory: string,
  name: string,
): Promise<{ path: string; release(line?: string): Promise<void>; close(): Promise<void> }> {
  if (process.platform === "win32") {
    throw new Error("Fixture release FIFOs require POSIX; use socket release on Windows");
  }
  const fifoPath = path.join(directory, name);
  await promisify(execFile)("mkfifo", [fifoPath]);
  const file = await fs
    .open(fifoPath, constants.O_RDWR | constants.O_NONBLOCK)
    .catch(async (error: unknown) => {
      await fs.unlink(fifoPath);
      throw error;
    });
  let closing: Promise<void> | undefined;
  return {
    path: fifoPath,
    async release(line = "release") {
      await file.write(line + "\n");
    },
    close() {
      closing ??= (async () => {
        try {
          await file.close();
        } finally {
          await fs.unlink(fifoPath);
        }
      })();
      return closing;
    },
  };
}

export function fixtureReceiptWorkerClientSource(broadcastName: string): string {
  return `import { BroadcastChannel as FixtureReceiptBroadcastChannel } from "node:worker_threads";
let fixtureReceiptBroadcast;
function sendReceipt(source, line) {
  if (!fixtureReceiptBroadcast) {
    fixtureReceiptBroadcast = new FixtureReceiptBroadcastChannel(${JSON.stringify(broadcastName)});
    // Test observation must never keep a product-owned fixture alive.
    fixtureReceiptBroadcast.unref();
  }
  fixtureReceiptBroadcast.postMessage({ source, line });
}`;
}
