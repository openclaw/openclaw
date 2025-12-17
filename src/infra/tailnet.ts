import os from "node:os";

export type TailnetAddresses = {
  ipv4: string[];
  ipv6: string[];
};

function isTailnetIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;

  // Tailscale IPv4 range: 100.64.0.0/10
  // https://tailscale.com/kb/1015/100.x-addresses
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

function isTailnetIPv6(address: string): boolean {
  // Tailscale IPv6 ULA prefix: fd7a:115c:a1e0::/48
  // (stable across tailnets; nodes get per-device suffixes)
  const normalized = address.trim().toLowerCase();
  return normalized.startsWith("fd7a:115c:a1e0:");
}

export function listTailnetAddresses(): TailnetAddresses {
  const ipv4: string[] = [];
  const ipv6: string[] = [];

  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const e of entries) {
      if (!e || e.internal) continue;
      const address = e.address?.trim();
      if (!address) continue;
      if (isTailnetIPv4(address)) ipv4.push(address);
      if (isTailnetIPv6(address)) ipv6.push(address);
    }
  }

  return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}

export function pickPrimaryTailnetIPv4(): string | undefined {
  return listTailnetAddresses().ipv4[0];
}

export function pickPrimaryTailnetIPv6(): string | undefined {
  return listTailnetAddresses().ipv6[0];
}
