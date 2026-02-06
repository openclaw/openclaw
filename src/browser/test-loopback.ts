import { createServer, type AddressInfo } from "node:net";

let cached: Promise<boolean> | null = null;

export async function canBindLoopback(): Promise<boolean> {
  if (cached) {
    return await cached;
  }
  cached = (async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as AddressInfo | null;
          if (!address) {
            server.close(() => resolve());
            return;
          }
          server.close((err) => (err ? reject(err) : resolve()));
        });
      });
      return true;
    } catch {
      return false;
    }
  })();
  return await cached;
}
