import type { Server as HttpServer } from "node:http";

export function removePortalServers(shared: HttpServer[], owned: readonly HttpServer[]): void {
  for (const server of owned) {
    const index = shared.indexOf(server);
    if (index >= 0) {
      shared.splice(index, 1);
    }
  }
}

export async function closePortalServers(servers: readonly HttpServer[]): Promise<void> {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
}
