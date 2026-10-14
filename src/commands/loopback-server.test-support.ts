import type { Server, Socket } from "node:net";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";

export async function withLoopbackTestServer<T>(
  server: Server,
  run: (port: number) => Promise<T>,
): Promise<T> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  let bound = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(portClaim.port, "127.0.0.1", () => {
        server.off("error", reject);
        bound = true;
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP listener");
    }
    return await run(address.port);
  } finally {
    if (bound) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Bun clears its native handle in close(); destroy tracked sockets directly.
        for (const socket of sockets) {
          socket.destroy();
        }
      });
    }
    await portClaim.release();
  }
}
