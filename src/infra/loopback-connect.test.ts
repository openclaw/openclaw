import { once } from "node:events";
import net from "node:net";
import { expect, it } from "vitest";
import { hasErrnoCode } from "./errno.js";
import { createLoopbackConnectOptions } from "./loopback-connect.js";

it.for([
  { family: 4, host: "127.0.0.1" },
  { family: 6, host: "::1" },
])("connects with an explicitly selected IPv$family lookup", async ({ family, host }, { skip }) => {
  const server = net.createServer((socket) => socket.end("loopback"));
  let socket: net.Socket | undefined;
  try {
    server.listen(0, host);
    try {
      await once(server, "listening");
    } catch (error) {
      // Containers without IPv6 loopback cannot bind ::1; report the case as skipped.
      if (hasErrnoCode(error, "EAFNOSUPPORT") || hasErrnoCode(error, "EADDRNOTAVAIL")) {
        skip(`IPv${family} loopback is unavailable on this host`);
      }
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener");
    }
    socket = net.connect({ ...createLoopbackConnectOptions(address.port), family });
    let response = "";
    for await (const chunk of socket) {
      response += chunk.toString();
    }
    expect(response).toBe("loopback");
  } finally {
    socket?.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
