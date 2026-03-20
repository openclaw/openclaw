import net from "node:net";
import { StringDecoder } from "node:string_decoder";

export async function requestJsonlSocket<T>(params: {
  socketPath: string;
  payload: string;
  timeoutMs: number;
  accept: (msg: unknown) => T | null | undefined;
}): Promise<T | null> {
  const { socketPath, payload, timeoutMs, accept } = params;
  return await new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    let buffer = "";
    // StringDecoder buffers incomplete multi-byte UTF-8 sequences across
    // TCP chunks, preventing U+FFFD replacement when a character boundary
    // falls on a chunk boundary.
    const decoder = new StringDecoder("utf8");

    const finish = (value: T | null) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    client.on("error", () => finish(null));
    client.connect(socketPath, () => {
      client.write(`${payload}\n`);
    });
    client.on("data", (data) => {
      buffer += decoder.write(data);
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) {
          continue;
        }
        try {
          const msg = JSON.parse(line) as unknown;
          const result = accept(msg);
          if (result === undefined) {
            continue;
          }
          clearTimeout(timer);
          finish(result);
          return;
        } catch {
          // ignore
        }
      }
    });
  });
}
