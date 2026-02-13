import net from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

export async function canListenOnLoopback(host = LOOPBACK_HOST): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.listen(0, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function getFreeLoopbackPort(host = LOOPBACK_HOST): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No TCP address")));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
