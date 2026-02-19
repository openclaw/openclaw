// Schema definitions for safety filters

/**
 * Safety Filters — Phase 2: Guardrails Layer
 *
 * Pre/post-execution filters for blocking sensitive content.
 * Includes PII detection, harmful content filtering, prompt injection detection.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface SafetyFilterConfig {
  /** Enable PII detection */
  detectPii?: boolean;
  /** Enable harmful content detection */
  detectHarmful?: boolean;
  /** Enable prompt injection detection */
  detectPromptInjection?: boolean;
  /** Enable bias detection */
  detectBias?: boolean;
  /** Custom blocklist patterns */
  customBlocklist?: string[];
  /** Custom allowlist patterns */
  customAllowlist?: string[];
  /** Minimum confidence for flagging (0-1) */
  confidenceThreshold?: number;
  /** Action on detection: 'block', 'warn', 'log' */
  action?: "block" | "warn" | "log";
  /** PII types to detect */
  piiTypes?: PiiType[];
}

export type PiiType =
  | "email"
  | "phone"
  | "ssn"
  | "credit_card"
  | "address"
  | "name"
  | "ip_address"
  | "api_key"
  | "password"
  | "token";

const DEFAULT_CONFIG: Required<SafetyFilterConfig> = {
  detectPii: true,
  detectHarmful: true,
  detectPromptInjection: true,
  detectBias: false,
  customBlocklist: [],
  customAllowlist: [],
  confidenceThreshold: 0.7,
  action: "block",
  piiTypes: ["email", "phone", "ssn", "credit_card", "api_key", "token"],
};

// ============================================================================
// Detection Patterns
// ============================================================================

const PII_PATTERNS: Record<PiiType, RegExp> = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
  ssn: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
  credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  address:
    /\d+\s+([a-zA-Z]+\s*){1,4}(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|circle|cir)\b/gi,
  name: /\b(name|full.?name|first.?name|last.?name)\s*[:=]\s*([a-zA-Z]+\s*){1,3}/gi,
  ip_address: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
  api_key: /\b(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi,
  password: /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi,
  token: /\b(?:token|auth[_-]?token|bearer)\s*[:=]\s*['"]?[a-zA-Z0-9_-]{16,}['"]?/gi,
};

const PROMPT_INJECTION_PATTERNS = [
  // Jailbreak patterns
  /ignore previous instructions/gi,
  /disregard.*instruction/gi,
  /forget.*told you/gi,
  /you are now .* mode/gi,
  /system.*override/gi,
  /DAN.*mode/gi,
  /jailbreak/gi,
  /ignore.*rules/gi,
  /bypass.*filter/gi,
  /you can .*(lie|deceive|harm)/gi,
  /pretend to be/gi,
  /roleplay as/gi,
  /new instructions:/gi,
  /\[system\]/gi,
  /\[admin\]/gi,
  /\[developer\]/gi,
  // Context manipulation
  /---\s*system:/gi,
  /\u003c\|system\|\u003e/gi,
  /\u003c\|user\|\u003e/gi,
  /\u003c\|assistant\|\u003e/gi,
  // Delimiter attacks
  /```\s*system/gi,
  /"""\s*system/gi,
  /\u003csystem\u003e/gi,
  /\{\{\s*system/gi,
];

const HARMFUL_PATTERNS = [
  // Self-harm
  /\b(kill|hurt|harm) (yourself|myself|oneself)\b/gi,
  /\bsuicide\b/gi,
  /\bself.?harm\b/gi,
  // Violence
  /\b(murder|assassinate|terrorist|bomb|weapon)\b/gi,
  // Discrimination
  /\b(racist|sexist|homophobic|transphobic|nazi|supremacist)\b/gi,
  /\b(hate speech|hateful)\b/gi,
  // CSAM (simplified - real implementation would use hash matching)
  /\b(child sexual abuse|csam|cp)\b/gi,
];

const BIAS_PATTERNS = [
  /\b(all|every) (men|women|people|group)\b/gi,
  /\b(natural|inherent|genetic) (superiority|inferiority)\b/gi,
  /\b(race|gender) determines\b/gi,
];

// ============================================================================
// Detection Results
// ============================================================================

export interface SafetyCheck {
  category: "pii" | "harmful" | "prompt_injection" | "bias" | "custom";
  type: string;
  severity: "high" | "medium" | "low";
  matchedText: string;
  position: { start: number; end: number };
  confidence: number;
}

export interface SafetyCheckResult {
  safe: boolean;
  flags: SafetyCheck[];
  redactedText?: string;
  action: "allow" | "block" | "warn";
}

// ============================================================================
// Safety Filter Class
// ============================================================================

export class SafetyFilter {
  private config: Required<SafetyFilterConfig>;

  constructor(config: SafetyFilterConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check content for safety violations
   */
  check(content: string): SafetyCheckResult {
    const flags: SafetyCheck[] = [];

    // PII detection
    if (this.config.detectPii) {
      flags.push(...this.detectPii(content));
    }

    // Prompt injection detection
    if (this.config.detectPromptInjection) {
      flags.push(...this.detectPromptInjection(content));
    }

    // Harmful content detection
    if (this.config.detectHarmful) {
      flags.push(...this.detectHarmful(content));
    }

    // Bias detection
    if (this.config.detectBias) {
      flags.push(...this.detectBias(content));
    }

    // Custom blocklist
    flags.push(...this.checkCustomBlocklist(content));

    // Filter by confidence threshold
    const significantFlags = flags.filter((f) => f.confidence >= this.config.confidenceThreshold);

    // Determine action
    const hasHighSeverity = significantFlags.some((f) => f.severity === "high");
    let action: "allow" | "block" | "warn" = "allow";

    if (this.config.action === "block" && (hasHighSeverity || significantFlags.length > 0)) {
      action = "block";
    } else if (this.config.action === "warn" && significantFlags.length > 0) {
      action = "warn";
    } else if (this.config.action === "log") {
      action = "allow"; // Just log, don't block
    }

    // Redact PII if detected
    let redactedText: string | undefined;
    if (this.config.detectPii && significantFlags.some((f) => f.category === "pii")) {
      redactedText = this.redactPii(content, significantFlags);
    }

    return {
      safe: significantFlags.length === 0,
      flags: significantFlags,
      redactedText,
      action,
    };
  }

  /**
   * Check and throw if unsafe
   */
  checkOrThrow(content: string): SafetyCheckResult {
    const result = this.check(content);
    if (result.action === "block") {
      throw new SafetyFilterError(
        `Content blocked: ${result.flags.map((f) => f.type).join(", ")}`,
        result.flags,
      );
    }
    return result;
  }

  /**
   * Redact PII from content
   */
  redact(content: string): string {
    const flags = this.detectPii(content);
    return this.redactPii(content, flags);
  }

  private detectPii(content: string): SafetyCheck[] {
    const flags: SafetyCheck[] = [];

    for (const type of this.config.piiTypes) {
      const pattern = PII_PATTERNS[type];
      if (!pattern) {
        continue;
      }

      let match;
      while ((match = pattern.exec(content)) !== null) {
        flags.push({
          category: "pii",
          type: `pii:${type}`,
          severity: type === "ssn" || type === "credit_card" ? "high" : "medium",
          matchedText: match[0],
          position: { start: match.index, end: match.index + match[0].length },
          confidence: 0.9,
        });
      }
      // Reset regex lastIndex
      pattern.lastIndex = 0;
    }

    return flags;
  }

  private detectPromptInjection(content: string): SafetyCheck[] {
    const flags: SafetyCheck[] = [];

    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        flags.push({
          category: "prompt_injection",
          type: "prompt_injection:jailbreak",
          severity: "high",
          matchedText: match[0],
          position: { start: match.index, end: match.index + match[0].length },
          confidence: 0.85,
        });
      }
      pattern.lastIndex = 0;
    }

    return flags;
  }

  private detectHarmful(content: string): SafetyCheck[] {
    const flags: SafetyCheck[] = [];

    for (const pattern of HARMFUL_PATTERNS) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        flags.push({
          category: "harmful",
          type: "harmful:violence",
          severity: "high",
          matchedText: match[0],
          position: { start: match.index, end: match.index + match[0].length },
          confidence: 0.8,
        });
      }
      pattern.lastIndex = 0;
    }

    return flags;
  }

  private detectBias(content: string): SafetyCheck[] {
    const flags: SafetyCheck[] = [];

    for (const pattern of BIAS_PATTERNS) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        flags.push({
          category: "bias",
          type: "bias:stereotype",
          severity: "medium",
          matchedText: match[0],
          position: { start: match.index, end: match.index + match[0].length },
          confidence: 0.75,
        });
      }
      pattern.lastIndex = 0;
    }

    return flags;
  }

  private checkCustomBlocklist(content: string): SafetyCheck[] {
    const flags: SafetyCheck[] = [];

    for (const pattern of this.config.customBlocklist) {
      try {
        const regex = new RegExp(pattern, "gi");
        let match;
        while ((match = regex.exec(content)) !== null) {
          flags.push({
            category: "custom",
            type: "custom:blocklist",
            severity: "high",
            matchedText: match[0],
            position: { start: match.index, end: match.index + match[0].length },
            confidence: 1.0,
          });
        }
      } catch {
        // Invalid regex, skip
      }
    }

    return flags;
  }

  private redactPii(content: string, flags: SafetyCheck[]): string {
    let redacted = content;
    // Sort by position end descending to replace from end to start
    const sortedFlags = [...flags]
      .filter((f) => f.category === "pii")
      .toSorted((a, b) => b.position.end - a.position.end);

    for (const flag of sortedFlags) {
      const replacement = `[${flag.type.toUpperCase().replace(":", "_")}]`;
      redacted =
        redacted.slice(0, flag.position.start) + replacement + redacted.slice(flag.position.end);
    }

    return redacted;
  }
}

/**
 * Safety filter error with flag details
 */
export class SafetyFilterError extends Error {
  constructor(
    message: string,
    public readonly flags: SafetyCheck[],
  ) {
    super(message);
    this.name = "SafetyFilterError";
  }
}

// ============================================================================
// Pre-configured Filters
// ============================================================================

/** Strict filter — blocks on any detection */
export const strictFilter = new SafetyFilter({
  detectPii: true,
  detectHarmful: true,
  detectPromptInjection: true,
  detectBias: true,
  confidenceThreshold: 0.6,
  action: "block",
});

/** Standard filter — blocks high/medium severity */
export const standardFilter = new SafetyFilter({
  detectPii: true,
  detectHarmful: true,
  detectPromptInjection: true,
  detectBias: false,
  confidenceThreshold: 0.7,
  action: "block",
});

/** Permissive filter — only blocks high severity */
export const permissiveFilter = new SafetyFilter({
  detectPii: true,
  detectHarmful: true,
  detectPromptInjection: true,
  detectBias: false,
  confidenceThreshold: 0.8,
  action: "block",
  piiTypes: ["ssn", "credit_card", "api_key", "token"],
});

/** Logging-only filter — never blocks, just logs */
export const loggingFilter = new SafetyFilter({
  detectPii: true,
  detectHarmful: true,
  detectPromptInjection: true,
  detectBias: false,
  confidenceThreshold: 0.5,
  action: "log",
});
