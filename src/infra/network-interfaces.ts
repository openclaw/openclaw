import os from "node:os";

export type NetworkInterfacesSnapshot = ReturnType<typeof os.networkInterfaces>;
type NetworkInterfaceFamily = "IPv4" | "IPv6";
type ExternalNetworkInterfaceAddress = {
  name: string;
  address: string;
  family: NetworkInterfaceFamily;
};

function normalizeNetworkInterfaceFamily(
  family: string | number | undefined,
): NetworkInterfaceFamily | undefined {
  // Node versions and test fixtures can expose family as either string or number.
  if (family === "IPv4" || family === 4) {
    return "IPv4";
  }
  return family === "IPv6" || family === 6 ? "IPv6" : undefined;
}

/** Best-effort interface read that returns undefined when OS inspection fails. */
export function safeNetworkInterfaces(
  networkInterfaces: () => NetworkInterfacesSnapshot = os.networkInterfaces,
): NetworkInterfacesSnapshot | undefined {
  try {
    return networkInterfaces();
  } catch {
    return undefined;
  }
}

export function listExternalInterfaceAddresses(
  snapshot: NetworkInterfacesSnapshot | undefined,
  family?: NetworkInterfaceFamily,
): ExternalNetworkInterfaceAddress[] {
  const addresses: ExternalNetworkInterfaceAddress[] = [];
  for (const [name, entries] of Object.entries(snapshot ?? {})) {
    for (const entry of entries ?? []) {
      if (!entry || entry.internal) {
        continue;
      }
      const address = entry.address?.trim();
      if (!address) {
        continue;
      }
      const entryFamily = normalizeNetworkInterfaceFamily(entry.family);
      if (!entryFamily || (family && entryFamily !== family)) {
        continue;
      }
      addresses.push({ name, address, family: entryFamily });
    }
  }

  return addresses;
}

/** Picks a matching external address, honoring preferred interface names first. */
export function pickMatchingExternalInterfaceAddress(
  snapshot: NetworkInterfacesSnapshot | undefined,
  params: {
    family: NetworkInterfaceFamily;
    preferredNames?: string[];
    matches?: (address: string) => boolean;
  },
): string | undefined {
  const { family, preferredNames = [], matches = () => true } = params;
  const addresses = listExternalInterfaceAddresses(snapshot, family);

  for (const name of preferredNames) {
    const preferred = addresses.find((entry) => entry.name === name && matches(entry.address));
    if (preferred) {
      return preferred.address;
    }
  }

  return addresses.find((entry) => matches(entry.address))?.address;
}
