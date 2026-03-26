/**
 * Exec allowlist matcher: determines if a command matches pre-approved patterns
 * Patterns can be exact strings or regex patterns (prefixed with regex:)
 */

export type ExecAllowlistConfig = {
  /** Array of allowed commands as exact strings or regex patterns */
  patterns?: string[];
  /** Enable allowlist matching (default: true if patterns provided) */
  enabled?: boolean;
};

export class ExecAllowlistMatcher {
  private patterns: (string | RegExp)[] = [];
  private enabled: boolean = false;

  constructor(config?: ExecAllowlistConfig) {
    if (config?.patterns && Array.isArray(config.patterns) && config.patterns.length > 0) {
      this.enabled = config.enabled !== false;
      this.patterns = config.patterns.map((pattern) => this.compilePattern(pattern));
    }
  }

  private compilePattern(pattern: string): string | RegExp {
    const trimmed = pattern.trim();
    if (trimmed.startsWith("regex:")) {
      const regexStr = trimmed.slice(6).trim();
      try {
        return new RegExp(regexStr);
      } catch {
        // Invalid regex, treat as exact string match
        return trimmed;
      }
    }
    return trimmed;
  }

  /**
   * Check if a command matches any allowed pattern
   */
  matches(command: string): boolean {
    if (!this.enabled || this.patterns.length === 0) {
      return false;
    }

    const cmd = command.trim();
    for (const pattern of this.patterns) {
      if (typeof pattern === "string") {
        // Exact match or substring match at start
        if (cmd === pattern || cmd.startsWith(`${pattern} `)) {
          return true;
        }
      } else {
        // Regex match
        if (pattern.test(cmd)) {
          return true;
        }
      }
    }
    return false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPatterns(): string[] {
    return this.patterns.map((p) => (p instanceof RegExp ? `regex:${p.source}` : p));
  }
}
