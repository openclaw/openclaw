import os from "node:os";

/**
 * Detect the primary IPv4 address on an overlay network interface.
 *
 * Detection strategies (tried in order):
 * 1. If `interfaceHint` is set → match interface names starting with that prefix
 * 2. Tailscale → IP in 100.64.0.0/10 range (any interface name)
 * 3. ZeroTier → interface name starts with `zt`
 * 4. WireGuard → interface name starts with `wg`
 * 5. Nebula → interface name starts with `nebula`
 *
 * Returns first non-internal IPv4 found, or `undefined`.
 */
export function pickOverlayIPv4(interfaceHint?: string): string | undefined {
  const ifaces = os.networkInterfaces();

  // 1. Explicit hint — match interfaces whose name starts with the hint prefix
  if (interfaceHint) {
    const prefix = interfaceHint.toLowerCase();
    for (const [name, entries] of Object.entries(ifaces)) {
      if (!entries || !name.toLowerCase().startsWith(prefix)) {
        continue;
      }
      for (const e of entries) {
        if (e.internal || e.family !== "IPv4") {
          continue;
        }
        return e.address;
      }
    }
    return undefined;
  }

  // Auto-detect: try each overlay strategy in order
  // 2. Tailscale (100.64.0.0/10 CGNAT range)
  for (const entries of Object.values(ifaces)) {
    if (!entries) {
      continue;
    }
    for (const e of entries) {
      if (e.internal || e.family !== "IPv4") {
        continue;
      }
      if (isTailscaleIPv4(e.address)) {
        return e.address;
      }
    }
  }

  // 3-5. Interface-name prefixes: ZeroTier, WireGuard, Nebula
  const prefixes = ["zt", "wg", "nebula"];
  for (const prefix of prefixes) {
    for (const [name, entries] of Object.entries(ifaces)) {
      if (!entries || !name.toLowerCase().startsWith(prefix)) {
        continue;
      }
      for (const e of entries) {
        if (e.internal || e.family !== "IPv4") {
          continue;
        }
        return e.address;
      }
    }
  }

  return undefined;
}

// Duplicated from tailnet.ts to keep this module self-contained.
function isTailscaleIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (octets.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}
