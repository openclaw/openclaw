import net from "node:net";
import type { Duplex } from "node:stream";

export function connectTargetOrigin(
  scheme: "http" | "https",
  target: { hostname: string; port: number },
): string {
  const host = net.isIPv6(target.hostname) ? `[${target.hostname}]` : target.hostname;
  return `${scheme}://${host}:${target.port}`;
}

// Decide from the literal host, never DNS: remote names must not gain cleartext
// forwarding just because an answer happens to be loopback.
export function isLiteralLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || (net.isIPv4(host) && host.startsWith("127."));
}

// Clients such as Node 24 fetch tunnel cleartext HTTP through CONNECT. Identify
// TLS by its handshake record without consuming the queued bytes.
export function startsWithTlsHandshake(socket: Duplex): Promise<boolean | null> {
  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(deadline);
      socket.off("readable", settle);
      socket.off("close", settle);
      const chunk: Buffer | null = socket.read();
      if (chunk) {
        socket.unshift(chunk);
      }
      resolve(chunk ? chunk[0] === 0x16 : null);
    };
    // Match the proxy's upstream connection deadline; silent peers must not
    // retain a process grant's socket indefinitely while choosing a protocol.
    const deadline = setTimeout(() => {
      socket.destroy();
      settle();
    }, 30_000);
    deadline.unref();
    socket.once("readable", settle);
    socket.once("close", settle);
    if (socket.destroyed || socket.readableLength > 0) {
      settle();
    }
  });
}
