// Real connect proof for the shared family-attempt budget. A fake timer cannot
// put Node's attempt timer ahead of a handshake that finished during a stall.
import type { LookupAddress, LookupOptions } from "node:dns";
import http from "node:http";
import type { AddressInfo, LookupFunction, Socket } from "node:net";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { isWSL2Sync } from "../wsl.js";
import { createPinnedLookup } from "./ssrf.js";
import { createHttp1Agent } from "./undici-runtime.js";

const HOSTNAME = "fixture.test";
// Above the previous 300 ms budget and below the 1 second budget.
const STALL_MS = 700;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function blockEventLoop(durationMs: number): void {
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    // The kernel can finish the handshake while this thread cannot observe it.
  }
}

function lookupWithStall(addresses: string[], stallMs: number): LookupFunction {
  const pinned = createPinnedLookup({ hostname: HOSTNAME, addresses }) as (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ) => void;
  return (hostname, options, callback) => {
    pinned(hostname, options, (err, address, family) => {
      callback(err, address, family);
      blockEventLoop(stallMs);
    });
  };
}

async function withListener(
  host: "127.0.0.1" | "::1",
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.end("ok");
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, host, () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  }
}

async function statusFromSharedAgent(port: number, lookup: LookupFunction): Promise<number> {
  const agent = createHttp1Agent({ connect: { lookup } });
  try {
    const response = await request(`http://${HOSTNAME}:${port}/`, { dispatcher: agent });
    await response.body.dump();
    return response.statusCode;
  } finally {
    await agent.close();
  }
}

describe("shared family attempt budget", () => {
  it.skipIf(isWSL2Sync())(
    "keeps a completed IPv4 connect when the event loop stalls past 300 ms",
    async () => {
      await withListener("127.0.0.1", async (port) => {
        const status = await statusFromSharedAgent(
          port,
          lookupWithStall(["127.0.0.1", "::1"], STALL_MS),
        );
        expect(status).toBe(200);
      });
    },
  );

  it.skipIf(isWSL2Sync())("reaches IPv6 when the IPv4 address refuses the connection", async () => {
    await withListener("::1", async (port) => {
      const status = await statusFromSharedAgent(port, lookupWithStall(["127.0.0.1", "::1"], 0));
      expect(status).toBe(200);
    });
  });
});
