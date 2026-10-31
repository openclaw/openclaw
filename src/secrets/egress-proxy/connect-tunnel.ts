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

// fetch tunnels cleartext HTTP through CONNECT, so a tunnel to loopback is TLS
// only if its first byte is a handshake record. The byte stays queued.
export function startsWithTlsHandshake(socket: Duplex): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = () => {
      socket.off("readable", settle);
      socket.off("close", settle);
      const chunk: Buffer | null = socket.read();
      if (chunk) {
        socket.unshift(chunk);
      }
      resolve(chunk?.[0] === 0x16);
    };
    socket.once("readable", settle);
    socket.once("close", settle);
  });
}
