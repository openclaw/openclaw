import os from "node:os";
function normalizeNetworkInterfaceFamily(family) {
    if (family === "IPv4" || family === 4) {
        return "IPv4";
    }
    if (family === "IPv6" || family === 6) {
        return "IPv6";
    }
    return undefined;
}
export function readNetworkInterfaces(networkInterfaces = os.networkInterfaces) {
    return networkInterfaces();
}
export function safeNetworkInterfaces(networkInterfaces = os.networkInterfaces) {
    try {
        return readNetworkInterfaces(networkInterfaces);
    }
    catch {
        return undefined;
    }
}
export function listExternalInterfaceAddresses(snapshot, family) {
    const addresses = [];
    if (!snapshot) {
        return addresses;
    }
    for (const [name, entries] of Object.entries(snapshot)) {
        if (!entries) {
            continue;
        }
        for (const entry of entries) {
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
export function pickMatchingExternalInterfaceAddress(snapshot, params) {
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
