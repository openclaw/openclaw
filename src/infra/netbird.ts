import os from "node:os";

export type NetbirdAddresses = {
  ipv4: string[];
  ipv6: string[];
};

const NETBIRD_INTERFACE_PREFIX = "wt";

export function listNetbirdAddresses(): NetbirdAddresses {
  const ipv4: string[] = [];
  const ipv6: string[] = [];

  const ifaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!name.startsWith(NETBIRD_INTERFACE_PREFIX) || !entries) {
      continue;
    }
    for (const e of entries) {
      if (!e || e.internal) {
        continue;
      }
      const address = e.address?.trim();
      if (!address) {
        continue;
      }
      if (e.family === "IPv4") {
        ipv4.push(address);
      } else if (e.family === "IPv6") {
        ipv6.push(address);
      }
    }
  }

  return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}

export function pickPrimaryNetbirdIPv4(): string | undefined {
  return listNetbirdAddresses().ipv4[0];
}

export function pickPrimaryNetbirdIPv6(): string | undefined {
  return listNetbirdAddresses().ipv6[0];
}
