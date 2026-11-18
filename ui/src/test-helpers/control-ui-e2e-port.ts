import { createServer as createNetServer } from "node:net";

export async function resolveAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close(() => reject(new Error("Could not reserve a loopback port")));
        return;
      }
      probe.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(address.port);
      });
    });
  });
}
