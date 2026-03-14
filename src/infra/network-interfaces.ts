import os from "node:os";

export type NetworkInterfacesMap = ReturnType<typeof os.networkInterfaces>;

export function readNetworkInterfacesSafely(
  read: () => NetworkInterfacesMap = os.networkInterfaces,
): NetworkInterfacesMap {
  try {
    return read() ?? {};
  } catch {
    // Some environments expose broken network interface state to libuv.
    // Treat that the same as "no interfaces" so the gateway can still start.
    return {};
  }
}
