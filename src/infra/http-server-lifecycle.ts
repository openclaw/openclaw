import type { Server } from "node:http";

export async function closeHttpServers(
  servers: readonly Server[],
  options?: { force?: boolean },
): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          if (options?.force) {
            server.closeAllConnections();
          }
        }),
    ),
  );
}
