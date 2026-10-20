import type { Server } from "node:http";
import type { Socket } from "node:net";

export async function listen(server: Server) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback media server did not expose a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async stop() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
