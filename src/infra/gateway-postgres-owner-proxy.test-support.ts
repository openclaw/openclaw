import net from "node:net";

/** Real PostgreSQL frames, with only delivery timing controlled by the test. */
export async function createOwnerProxy(connection: string, stopAfterReady: number) {
  const target = new URL(connection);
  const upstream = { port: Number(target.port || 5432), host: target.hostname };
  const sockets: net.Socket[] = [];
  const retained: Buffer[] = [];
  let ready = 0;
  let pending = Buffer.alloc(0);
  let downstream: net.Socket | undefined;
  let unexpectedConnections = 0;
  let bufferedReady!: () => void;
  let bufferedFatal!: () => void;
  const stopped = new Promise<void>((resolve) => {
    bufferedReady = resolve;
  });
  const fatal = new Promise<void>((resolve) => {
    bufferedFatal = resolve;
  });
  const server = net.createServer((inbound) => {
    downstream = inbound;
    const outbound = net.connect(upstream.port, upstream.host);
    sockets.push(inbound, outbound);
    inbound.on("data", (chunk) => {
      if (ready < stopAfterReady) {
        outbound.write(chunk);
      }
    });
    outbound.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1) + 1;
        if (pending.length < length) {
          break;
        }
        const frame = pending.subarray(0, length);
        pending = pending.subarray(length);
        // Startup ReadyForQuery is forwarded; the selected query's complete
        // result can be retained together with a later server FATAL.
        if (ready >= stopAfterReady - 1 && stopAfterReady > 1) {
          retained.push(frame);
        } else if (ready < stopAfterReady) {
          inbound.write(frame);
        }
        if (frame[0] === 90) {
          ready++;
          if (ready === stopAfterReady) {
            bufferedReady();
          }
        }
        if (frame[0] === 69 && ready >= stopAfterReady) {
          bufferedFatal();
        }
      }
    });
    inbound.on("error", () => outbound.destroy());
    outbound.on("error", () => inbound.destroy());
    inbound.on("close", () => outbound.destroy());
    // Keep the downstream open after server termination: the race proof must
    // observe real FATAL bytes, not depend on a later TCP close notification.
  });
  // Each fixture owns exactly one client; a routing mistake must fail within
  // this listener rather than opening an unbounded chain of local sockets.
  server.maxConnections = 1;
  server.on("drop", () => {
    unexpectedConnections++;
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP proxy");
  }
  target.host = `127.0.0.1:${address.port}`;
  return {
    connection: target.toString(),
    port: address.port,
    stopped,
    fatal,
    forwardRetained() {
      const bytes = Buffer.concat(retained.splice(0));
      downstream?.write(bytes);
      return bytes.length;
    },
    async close(this: void) {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (unexpectedConnections) {
        throw new Error("Owner proxy received an unexpected connection");
      }
    },
  };
}
