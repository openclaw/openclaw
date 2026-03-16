export interface TrustedProxyConfig {
  addresses: string[];
  allowInternal: boolean;
  rejectOnMissing: boolean;
}

export interface ProxyConfigValidationResult {
  ok: true;
  warnings: string[];
}
export interface ProxyConfigValidationError {
  ok: false;
  errors: string[];
  warnings: string[];
}
export type ProxyConfigValidation = ProxyConfigValidationResult | ProxyConfigValidationError;

const PRIVATE_RANGES = [
  { prefix: "10.", description: "RFC 1918 - 10.0.0.0/8" },
  { prefix: "172.16.", description: "RFC 1918 - 172.16.0.0/12" },
  { prefix: "192.168.", description: "RFC 1918 - 192.168.0.0/16" },
  { prefix: "127.", description: "Loopback" },
  { prefix: "169.254.", description: "Link-local" },
  { prefix: "::1", description: "IPv6 loopback" },
  { prefix: "fc00:", description: "IPv6 unique local" },
  { prefix: "fe80:", description: "IPv6 link-local" },
];

const DANGEROUS_PATTERNS = [
  { pattern: "0.0.0.0", reason: "binds to all interfaces" },
  { pattern: "::", reason: "binds to all interfaces (IPv6)" },
  { pattern: "0.0.0.0/0", reason: "allows any IPv4" },
  { pattern: "::/0", reason: "allows any IPv6" },
];

export function isPrivateRange(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();
  return PRIVATE_RANGES.some((range) => normalized.startsWith(range.prefix));
}

export function isDangerousProxyConfig(proxies: string[]): {
  dangerous: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  for (const proxy of proxies) {
    for (const danger of DANGEROUS_PATTERNS) {
      if (proxy === danger.pattern || proxy.startsWith(danger.pattern)) {
        reasons.push(`${proxy}: ${danger.reason}`);
      }
    }
  }

  return {
    dangerous: reasons.length > 0,
    reasons,
  };
}

export function validateTrustedProxyConfig(config: TrustedProxyConfig): ProxyConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (config.addresses.length === 0) {
    if (config.rejectOnMissing) {
      errors.push("no trusted proxies configured but rejectOnMissing is true");
    } else {
      warnings.push("no trusted proxies configured - forwarded headers will be ignored");
    }
    return { ok: false, errors, warnings };
  }

  const dangerous = isDangerousProxyConfig(config.addresses);
  if (dangerous.dangerous) {
    errors.push(...dangerous.reasons);
  }

  const hasPublic = config.addresses.some((ip) => !isPrivateRange(ip));
  if (hasPublic && !config.allowInternal) {
    warnings.push("public IP addresses in trusted proxies without allowInternal flag");
  }

  const uniqueAddresses = new Set(config.addresses);
  if (uniqueAddresses.size < config.addresses.length) {
    warnings.push("duplicate addresses in trusted proxies configuration");
  }

  for (const ip of config.addresses) {
    if (ip.includes("*")) {
      warnings.push(`wildcard in proxy address: ${ip} - may be too permissive`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  return { ok: true, warnings };
}

export function parseProxyConfig(envValue: string | undefined): TrustedProxyConfig {
  if (!envValue) {
    return {
      addresses: [],
      allowInternal: true,
      rejectOnMissing: false,
    };
  }

  const addresses = envValue
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  return {
    addresses,
    allowInternal: true,
    rejectOnMissing: false,
  };
}

export function formatProxyWarningMessage(result: ProxyConfigValidation): string {
  if (result.ok && result.warnings.length === 0) {
    return "Trusted proxy configuration is valid.";
  }

  const parts: string[] = [];

  if (!result.ok && result.errors.length > 0) {
    parts.push("ERRORS:");
    parts.push(...result.errors.map((e) => `  - ${e}`));
  }

  if (result.warnings.length > 0) {
    parts.push("WARNINGS:");
    parts.push(...result.warnings.map((w) => `  - ${w}`));
  }

  return parts.join("\n");
}
