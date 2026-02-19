import type { IndicatorOfCompromise, IoCType } from "../types.js";

/**
 * Match an indicator value against stored IOCs.
 */
export class IoCMatcher {
  /**
   * Check if a value matches an IOC, considering type-specific matching rules.
   */
  static matches(ioc: IndicatorOfCompromise, value: string): boolean {
    const normalizedValue = value.toLowerCase().trim();
    const normalizedIoc = ioc.value.toLowerCase().trim();

    switch (ioc.type) {
      case "ip":
        return this.matchIp(normalizedIoc, normalizedValue);
      case "domain":
        return this.matchDomain(normalizedIoc, normalizedValue);
      case "url":
        return this.matchUrl(normalizedIoc, normalizedValue);
      case "hash":
        return normalizedIoc === normalizedValue;
      case "filepath":
        return normalizedValue.includes(normalizedIoc) || normalizedIoc.includes(normalizedValue);
      case "email":
        return normalizedIoc === normalizedValue;
      default:
        return normalizedIoc === normalizedValue;
    }
  }

  /**
   * Match IP addresses (supports CIDR notation).
   */
  private static matchIp(pattern: string, value: string): boolean {
    // Exact match
    if (pattern === value) {
      return true;
    }

    // CIDR notation match
    if (pattern.includes("/")) {
      try {
        const [network, prefixLength] = pattern.split("/");
        const prefix = Number.parseInt(prefixLength, 10);
        if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
          return false;
        }
        return this.ipInCidr(value, network, prefix);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Check if an IP is within a CIDR range.
   */
  private static ipInCidr(ip: string, network: string, prefixLength: number): boolean {
    const ipParts = ip.split(".").map((p) => Number.parseInt(p, 10));
    const networkParts = network.split(".").map((p) => Number.parseInt(p, 10));

    if (ipParts.length !== 4 || networkParts.length !== 4) {
      return false;
    }

    const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
    const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const networkNum =
      (networkParts[0] << 24) |
      (networkParts[1] << 16) |
      (networkParts[2] << 8) |
      networkParts[3];

    return (ipNum & mask) === (networkNum & mask);
  }

  /**
   * Match domain names (supports subdomain matching).
   */
  private static matchDomain(pattern: string, value: string): boolean {
    // Exact match
    if (pattern === value) {
      return true;
    }

    // Subdomain match: pattern is a subdomain of value or vice versa
    if (value.endsWith(`.${pattern}`) || pattern.endsWith(`.${value}`)) {
      return true;
    }

    return false;
  }

  /**
   * Match URLs (checks domain and path).
   */
  private static matchUrl(pattern: string, value: string): boolean {
    try {
      const patternUrl = new URL(pattern);
      const valueUrl = new URL(value);

      // Match domain
      if (patternUrl.hostname !== valueUrl.hostname) {
        return this.matchDomain(patternUrl.hostname, valueUrl.hostname);
      }

      // Match path (pattern path is a prefix of value path)
      if (patternUrl.pathname && !valueUrl.pathname.startsWith(patternUrl.pathname)) {
        return false;
      }

      return true;
    } catch {
      // If URL parsing fails, fall back to string matching
      return value.includes(pattern) || pattern.includes(value);
    }
  }

  /**
   * Infer IOC type from a value.
   */
  static inferType(value: string): IoCType {
    const normalized = value.toLowerCase().trim();

    // IP address (IPv4)
    if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(normalized)) {
      return "ip";
    }

    // Hash (MD5, SHA1, SHA256)
    if (/^[a-f0-9]{32}$/.test(normalized)) {
      return "hash";
    }
    if (/^[a-f0-9]{40}$/.test(normalized)) {
      return "hash";
    }
    if (/^[a-f0-9]{64}$/.test(normalized)) {
      return "hash";
    }

    // Email
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return "email";
    }

    // URL
    if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
      return "url";
    }

    // Domain
    if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/i.test(
      normalized,
    )) {
      return "domain";
    }

    // File path
    if (normalized.includes("/") || normalized.includes("\\")) {
      return "filepath";
    }

    return "other";
  }
}
