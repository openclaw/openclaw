/**
 * SECURITY: Connection Allowlist System
 *
 * Controls which external services the application can connect to,
 * preventing unauthorized outbound connections. This provides defense-in-depth
 * against:
 * 1. Rogue connections from compromised code
 * 2. Unintended data exfiltration
 * 3. SSRF attacks that bypass URL-level filtering
 *
 * Features:
 * - Domain-based allowlisting with wildcard support
 * - Protocol restrictions (https-only option)
 * - Port restrictions
 * - Connection logging for audit
 * - Runtime configuration updates
 */

export type ConnectionCategory =
  | "llm-api" // LLM provider APIs (Anthropic, OpenAI, etc.)
  | "messaging" // Messaging services (WhatsApp, Telegram, etc.)
  | "cloud-storage" // Cloud storage (S3, GCS, etc.)
  | "webhook" // Webhook endpoints
  | "browser" // Browser automation targets
  | "internal" // Internal/local services
  | "custom"; // User-defined

export type AllowlistEntry = {
  /** Domain pattern (supports wildcards: *.example.com) */
  domain: string;
  /** Allowed ports (empty = all ports) */
  ports?: number[];
  /** Allowed protocols (empty = all protocols) */
  protocols?: ("http" | "https" | "ws" | "wss")[];
  /** Category for logging/reporting */
  category: ConnectionCategory;
  /** Human-readable description */
  description: string;
  /** Whether this entry is enabled */
  enabled: boolean;
  /** Whether to log connections to this domain */
  logConnections: boolean;
};

export type ConnectionAttempt = {
  id: string;
  url: string;
  domain: string;
  port: number;
  protocol: string;
  category?: ConnectionCategory;
  allowed: boolean;
  reason: string;
  timestamp: number;
  source?: string; // Calling code location hint
};

export type AllowlistConfig = {
  /** Whether allowlist is enforced (false = log-only mode) */
  enforced: boolean;
  /** Default action for unlisted domains */
  defaultAction: "allow" | "deny";
  /** Whether to log all connection attempts */
  logAllAttempts: boolean;
  /** Maximum connection log size */
  maxLogSize: number;
  /** Allow all localhost connections */
  allowLocalhost: boolean;
  /** Allow all private IP connections */
  allowPrivateIps: boolean;
};

// Default allowlist entries for known services
const DEFAULT_ALLOWLIST: AllowlistEntry[] = [
  // LLM API Providers
  {
    domain: "api.anthropic.com",
    protocols: ["https"],
    category: "llm-api",
    description: "Anthropic Claude API",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "api.openai.com",
    protocols: ["https"],
    category: "llm-api",
    description: "OpenAI API",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "*.googleapis.com",
    protocols: ["https"],
    category: "llm-api",
    description: "Google Cloud APIs (Gemini, etc.)",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "*.anthropic.com",
    protocols: ["https"],
    category: "llm-api",
    description: "Anthropic services",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "bedrock-runtime.*.amazonaws.com",
    protocols: ["https"],
    category: "llm-api",
    description: "AWS Bedrock",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "*.bedrock.*.amazonaws.com",
    protocols: ["https"],
    category: "llm-api",
    description: "AWS Bedrock (alternate)",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "api.github.com",
    protocols: ["https"],
    category: "llm-api",
    description: "GitHub API (for Copilot)",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "copilot-proxy.githubusercontent.com",
    protocols: ["https"],
    category: "llm-api",
    description: "GitHub Copilot",
    enabled: true,
    logConnections: true,
  },

  // Messaging Services
  {
    domain: "*.whatsapp.net",
    protocols: ["https", "wss"],
    category: "messaging",
    description: "WhatsApp Web",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "web.whatsapp.com",
    protocols: ["https", "wss"],
    category: "messaging",
    description: "WhatsApp Web",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "api.telegram.org",
    protocols: ["https"],
    category: "messaging",
    description: "Telegram Bot API",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "*.discord.com",
    protocols: ["https", "wss"],
    category: "messaging",
    description: "Discord",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "discord.gg",
    protocols: ["https"],
    category: "messaging",
    description: "Discord",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "*.slack.com",
    protocols: ["https", "wss"],
    category: "messaging",
    description: "Slack",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "slack.com",
    protocols: ["https", "wss"],
    category: "messaging",
    description: "Slack",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "*.signal.org",
    protocols: ["https"],
    category: "messaging",
    description: "Signal",
    enabled: true,
    logConnections: true,
  },

  // Cloud Storage
  {
    domain: "*.s3.amazonaws.com",
    protocols: ["https"],
    category: "cloud-storage",
    description: "AWS S3",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "s3.*.amazonaws.com",
    protocols: ["https"],
    category: "cloud-storage",
    description: "AWS S3 (regional)",
    enabled: true,
    logConnections: true,
  },
  {
    domain: "storage.googleapis.com",
    protocols: ["https"],
    category: "cloud-storage",
    description: "Google Cloud Storage",
    enabled: true,
    logConnections: true,
  },

  // Internal/Local
  {
    domain: "localhost",
    category: "internal",
    description: "Localhost",
    enabled: true,
    logConnections: false,
  },
  {
    domain: "127.0.0.1",
    category: "internal",
    description: "Loopback IPv4",
    enabled: true,
    logConnections: false,
  },
  {
    domain: "::1",
    category: "internal",
    description: "Loopback IPv6",
    enabled: true,
    logConnections: false,
  },
  {
    domain: "*.ts.net",
    category: "internal",
    description: "Tailscale network",
    enabled: true,
    logConnections: false,
  },
  {
    domain: "*.moltbot.internal",
    category: "internal",
    description: "Moltbot internal",
    enabled: true,
    logConnections: false,
  },
];

const DEFAULT_CONFIG: AllowlistConfig = {
  enforced: true,
  defaultAction: "deny",
  logAllAttempts: true,
  maxLogSize: 10000,
  allowLocalhost: true,
  allowPrivateIps: false,
};

/**
 * Connection Allowlist Manager
 */
export class ConnectionAllowlist {
  private entries: AllowlistEntry[] = [];
  private config: AllowlistConfig;
  private connectionLog: ConnectionAttempt[] = [];
  private listeners: ((attempt: ConnectionAttempt) => void)[] = [];

  constructor(customEntries?: AllowlistEntry[], configOverrides?: Partial<AllowlistConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...configOverrides };
    this.entries = [...DEFAULT_ALLOWLIST, ...(customEntries ?? [])];
  }

  /**
   * Check if a connection to a URL is allowed.
   */
  check(url: string, source?: string): ConnectionAttempt {
    const parsed = this.parseUrl(url);
    const id = `conn-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    if (!parsed) {
      const attempt: ConnectionAttempt = {
        id,
        url,
        domain: "unknown",
        port: 0,
        protocol: "unknown",
        allowed: false,
        reason: "invalid_url",
        timestamp: Date.now(),
        source,
      };
      this.logAttempt(attempt);
      return attempt;
    }

    const { domain, port, protocol } = parsed;

    // Check localhost exception
    if (this.config.allowLocalhost && this.isLocalhost(domain)) {
      const attempt: ConnectionAttempt = {
        id,
        url,
        domain,
        port,
        protocol,
        category: "internal",
        allowed: true,
        reason: "localhost_allowed",
        timestamp: Date.now(),
        source,
      };
      this.logAttempt(attempt);
      return attempt;
    }

    // Check private IP exception
    if (this.config.allowPrivateIps && this.isPrivateIp(domain)) {
      const attempt: ConnectionAttempt = {
        id,
        url,
        domain,
        port,
        protocol,
        category: "internal",
        allowed: true,
        reason: "private_ip_allowed",
        timestamp: Date.now(),
        source,
      };
      this.logAttempt(attempt);
      return attempt;
    }

    // Find matching allowlist entry
    const entry = this.findMatchingEntry(domain, port, protocol);

    if (entry) {
      if (!entry.enabled) {
        const attempt: ConnectionAttempt = {
          id,
          url,
          domain,
          port,
          protocol,
          category: entry.category,
          allowed: !this.config.enforced, // Allow if not enforced
          reason: this.config.enforced ? "entry_disabled" : "entry_disabled_warning",
          timestamp: Date.now(),
          source,
        };
        this.logAttempt(attempt);
        return attempt;
      }

      const attempt: ConnectionAttempt = {
        id,
        url,
        domain,
        port,
        protocol,
        category: entry.category,
        allowed: true,
        reason: "allowlist_match",
        timestamp: Date.now(),
        source,
      };
      if (entry.logConnections) {
        this.logAttempt(attempt);
      }
      return attempt;
    }

    // No match - apply default action
    const allowed = this.config.defaultAction === "allow" || !this.config.enforced;
    const attempt: ConnectionAttempt = {
      id,
      url,
      domain,
      port,
      protocol,
      allowed,
      reason: allowed
        ? this.config.enforced
          ? "default_allow"
          : "not_enforced"
        : "not_in_allowlist",
      timestamp: Date.now(),
      source,
    };
    this.logAttempt(attempt);
    return attempt;
  }

  /**
   * Find a matching allowlist entry for a domain/port/protocol.
   */
  private findMatchingEntry(domain: string, port: number, protocol: string): AllowlistEntry | null {
    const normalizedDomain = domain.toLowerCase();
    const normalizedProtocol = protocol.toLowerCase().replace(":", "") as
      | "http"
      | "https"
      | "ws"
      | "wss";

    for (const entry of this.entries) {
      // Check domain match
      if (!this.domainMatches(normalizedDomain, entry.domain.toLowerCase())) {
        continue;
      }

      // Check port match (empty = all ports)
      if (entry.ports && entry.ports.length > 0 && !entry.ports.includes(port)) {
        continue;
      }

      // Check protocol match (empty = all protocols)
      if (
        entry.protocols &&
        entry.protocols.length > 0 &&
        !entry.protocols.includes(normalizedProtocol)
      ) {
        continue;
      }

      return entry;
    }

    return null;
  }

  /**
   * Check if a domain matches a pattern (with wildcard support).
   */
  private domainMatches(domain: string, pattern: string): boolean {
    // Exact match
    if (domain === pattern) {
      return true;
    }

    // Wildcard matching
    if (pattern.includes("*")) {
      // Convert pattern to regex
      const regexPattern = pattern
        .replace(/\./g, "\\.") // Escape dots
        .replace(/\*/g, "[^.]+"); // Convert * to match domain segment
      const regex = new RegExp(`^${regexPattern}$`, "i");
      return regex.test(domain);
    }

    return false;
  }

  /**
   * Parse a URL into components.
   */
  private parseUrl(url: string): { domain: string; port: number; protocol: string } | null {
    try {
      const parsed = new URL(url);
      const defaultPorts: Record<string, number> = {
        "http:": 80,
        "https:": 443,
        "ws:": 80,
        "wss:": 443,
      };
      const port = parsed.port ? parseInt(parsed.port, 10) : (defaultPorts[parsed.protocol] ?? 443);

      return {
        domain: parsed.hostname,
        port,
        protocol: parsed.protocol,
      };
    } catch {
      return null;
    }
  }

  /**
   * Check if a domain is localhost.
   */
  private isLocalhost(domain: string): boolean {
    const localhostPatterns = ["localhost", "127.0.0.1", "::1", "[::1]"];
    return localhostPatterns.includes(domain.toLowerCase());
  }

  /**
   * Check if a domain is a private IP.
   */
  private isPrivateIp(domain: string): boolean {
    // IPv4 private ranges
    const ipv4PrivatePatterns = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^169\.254\./, // Link-local
    ];

    // IPv6 private patterns
    const ipv6PrivatePatterns = [
      /^fe80:/i, // Link-local
      /^fc/i, // Unique local
      /^fd/i, // Unique local
    ];

    for (const pattern of ipv4PrivatePatterns) {
      if (pattern.test(domain)) {
        return true;
      }
    }

    for (const pattern of ipv6PrivatePatterns) {
      if (pattern.test(domain)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Log a connection attempt.
   */
  private logAttempt(attempt: ConnectionAttempt): void {
    if (!this.config.logAllAttempts && attempt.allowed) {
      return;
    }

    this.connectionLog.push(attempt);

    // Trim log if too large
    if (this.connectionLog.length > this.config.maxLogSize) {
      this.connectionLog = this.connectionLog.slice(-this.config.maxLogSize / 2);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(attempt);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Add a listener for connection attempts.
   */
  onConnectionAttempt(listener: (attempt: ConnectionAttempt) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Get recent connection log.
   */
  getConnectionLog(limit = 100, deniedOnly = false): ConnectionAttempt[] {
    let log = this.connectionLog;
    if (deniedOnly) {
      log = log.filter((a) => !a.allowed);
    }
    return log.slice(-limit);
  }

  /**
   * Add a custom allowlist entry.
   */
  addEntry(entry: AllowlistEntry): void {
    this.entries.push(entry);
  }

  /**
   * Remove an allowlist entry by domain.
   */
  removeEntry(domain: string): boolean {
    const index = this.entries.findIndex((e) => e.domain === domain);
    if (index !== -1) {
      this.entries.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Enable or disable an allowlist entry.
   */
  setEntryEnabled(domain: string, enabled: boolean): boolean {
    const entry = this.entries.find((e) => e.domain === domain);
    if (entry) {
      entry.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Get all allowlist entries.
   */
  getEntries(): AllowlistEntry[] {
    return [...this.entries];
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<AllowlistConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): AllowlistConfig {
    return { ...this.config };
  }

  /**
   * Get statistics about connections.
   */
  getStats(): {
    totalAttempts: number;
    allowedAttempts: number;
    deniedAttempts: number;
    byCategory: Record<string, { allowed: number; denied: number }>;
    byReason: Record<string, number>;
  } {
    const stats = {
      totalAttempts: this.connectionLog.length,
      allowedAttempts: 0,
      deniedAttempts: 0,
      byCategory: {} as Record<string, { allowed: number; denied: number }>,
      byReason: {} as Record<string, number>,
    };

    for (const attempt of this.connectionLog) {
      if (attempt.allowed) {
        stats.allowedAttempts++;
      } else {
        stats.deniedAttempts++;
      }

      const category = attempt.category ?? "unknown";
      if (!stats.byCategory[category]) {
        stats.byCategory[category] = { allowed: 0, denied: 0 };
      }
      if (attempt.allowed) {
        stats.byCategory[category].allowed++;
      } else {
        stats.byCategory[category].denied++;
      }

      stats.byReason[attempt.reason] = (stats.byReason[attempt.reason] ?? 0) + 1;
    }

    return stats;
  }
}

// Singleton instance
let connectionAllowlist: ConnectionAllowlist | null = null;

/**
 * Get the singleton connection allowlist instance.
 */
export function getConnectionAllowlist(): ConnectionAllowlist {
  if (!connectionAllowlist) {
    connectionAllowlist = new ConnectionAllowlist();
  }
  return connectionAllowlist;
}

/**
 * Check if a connection to a URL is allowed.
 */
export function checkConnection(url: string, source?: string): ConnectionAttempt {
  return getConnectionAllowlist().check(url, source);
}

/**
 * Check if a connection is allowed and throw if not.
 */
export function assertConnectionAllowed(url: string, source?: string): void {
  const attempt = checkConnection(url, source);
  if (!attempt.allowed) {
    throw new Error(
      `Connection to ${attempt.domain} blocked: ${attempt.reason}. ` +
        `Add to allowlist if this connection is expected.`,
    );
  }
}
