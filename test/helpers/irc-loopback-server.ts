import net from "node:net";

export type LoopbackIrcServer = {
  port: number;
  lines: string[];
  close(): Promise<void>;
};

export async function startLoopbackIrcServer(): Promise<LoopbackIrcServer> {
  const lines: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        lines.push(line);
        if (line.startsWith("USER ")) {
          socket.write(":server 001 bot :welcome\r\n");
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback IRC server to bind a TCP port");
  }
  return {
    port: address.port,
    lines,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
