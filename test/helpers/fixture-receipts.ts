import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { BroadcastChannel } from "node:worker_threads";

/**
 * Socket clients observe product-spawned children; broadcast clients observe worker threads
 * in the test process. Receipts are not ordered with the fixture's other output or exit.
 * A wait raced against an operation the child's replies can settle must confirm against a durable
 * record the child writes before replying.
 */
export type FixtureReceiptChannel = {
  readonly endpoint: string;
  readonly broadcastName: string;
  waitFor(source: string, text: string, count?: number): Promise<void>;
  close(): Promise<void>;
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
  // openclaw-temp-dir: allow short private socket path below macOS's Unix socket limit
  const directory =
    process.platform === "win32" ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "oc-r-"));
  const endpoint = directory
    ? path.join(directory, "s")
    : `\\\\.\\pipe\\openclaw-fixture-receipts-${process.pid}-${randomUUID()}`;
  const broadcastName = `openclaw-fixture-receipts:${randomUUID()}`;
  const broadcast = new BroadcastChannel(broadcastName);
  const receipts = new Map<string, string[]>();
  const waiters = new Set<Waiter>();
  const sockets = new Set<net.Socket>();
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
  };
  const record = (receipt: unknown) => {
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
          record(receipt);
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
function sendReceipt(source, line) {
  if (!fixtureReceiptSocket) {
    fixtureReceiptSocket = connectFixtureReceipts(${JSON.stringify(endpoint)});
    fixtureReceiptSocket.on("error", () => {});
    // Test observation must never keep a product-owned fixture alive.
    fixtureReceiptSocket.unref();
  }
  fixtureReceiptSocket.write(JSON.stringify({ source, line }) + "\\n");
}`;
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
