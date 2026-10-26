import net from "node:net";
import { sleep } from "../utils.js";

export async function waitForGatewayPort(params: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({
        host: params.host,
        port: params.port,
      });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
    if (connected) {
      return;
    }
    await sleep(250);
  }

  throw new Error(`timed out waiting for gateway port ${params.host}:${String(params.port)}`);
}
