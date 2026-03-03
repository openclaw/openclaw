import os from "node:os";
import { isIpInCidr } from "../shared/net/ip.js";
const TAILNET_IPV4_CIDR = "100.64.0.0/10";
const TAILNET_IPV6_CIDR = "fd7a:115c:a1e0::/48";
export function isTailnetIPv4(address) {
    // Tailscale IPv4 range: 100.64.0.0/10
    // https://tailscale.com/kb/1015/100.x-addresses
    return isIpInCidr(address, TAILNET_IPV4_CIDR);
}
function isTailnetIPv6(address) {
    // Tailscale IPv6 ULA prefix: fd7a:115c:a1e0::/48
    // (stable across tailnets; nodes get per-device suffixes)
    return isIpInCidr(address, TAILNET_IPV6_CIDR);
}
export function listTailnetAddresses() {
    const ipv4 = [];
    const ipv6 = [];
    const ifaces = os.networkInterfaces();
    for (const entries of Object.values(ifaces)) {
        if (!entries) {
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
            if (isTailnetIPv4(address)) {
                ipv4.push(address);
            }
            if (isTailnetIPv6(address)) {
                ipv6.push(address);
            }
        }
    }
    return { ipv4: [...new Set(ipv4)], ipv6: [...new Set(ipv6)] };
}
export function pickPrimaryTailnetIPv4() {
    return listTailnetAddresses().ipv4[0];
}
export function pickPrimaryTailnetIPv6() {
    return listTailnetAddresses().ipv6[0];
}
