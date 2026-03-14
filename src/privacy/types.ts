/**
 * Privacy filter types for the OpenClaw privacy detection and replacement system.
 */

/** Risk level for detected privacy content. */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** A single detection match found in text. */
export interface DetectionMatch {
  /** Privacy type identifier (e.g. "email", "password", "api_key"). */
  type: string;
  /** The matched sensitive content. */
  content: string;
  /** Start index in the original text. */
  start: number;
  /** End index in the original text. */
  end: number;
  /** Risk level of this match. */
  riskLevel: RiskLevel;
  /** Human-readable description. */
  description: string;
  /** Custom replacement template from the rule, if any. */
  replacementTemplate?: string;
}

/** Result of privacy filtering on a text. */
export interface FilterResult {
  /** Whether any privacy risk was detected. */
  hasPrivacyRisk: boolean;
  /** All detected matches. */
  matches: DetectionMatch[];
  /** Count of matches by privacy type. */
  riskCount: Record<string, number>;
  /** The highest risk level found, or null if none. */
  highestRiskLevel: RiskLevel | null;
}

/** Context requirements for a detection rule. */
export interface RuleContext {
  /** Keywords that must appear near the match. */
  mustContain?: string[];
  /** Keywords that must not appear near the match. */
  mustNotContain?: string[];
}

/** A privacy detection rule. */
export interface PrivacyRule {
  /** Privacy type identifier. */
  type: string;
  /** Human-readable description. */
  description: string;
  /** Whether this rule is enabled. */
  enabled: boolean;
  /** Risk level. */
  riskLevel: RiskLevel;
  /** Regex pattern string (optional if keywords are used). */
  pattern?: string;
  /** Keyword list for keyword-based matching. */
  keywords?: string[];
  /** Whether keyword matching is case-sensitive. */
  caseSensitive?: boolean;
  /** Context constraints to reduce false positives. */
  context?: RuleContext;
  /**
   * Optional post-match validator function.
   * Receives the matched string, returns true if it's a genuine match.
   * Used for complex validations that can't be expressed in regex alone
   * (e.g. password complexity, Shannon entropy).
   */
  validate?: (matched: string) => boolean;
  /** Custom replacement template string for user-defined rules. */
  replacementTemplate?: string;
}

/** A mapping between original sensitive content and its replacement. */
export interface PrivacyMapping {
  /** Unique ID: pf_{timestamp}_{seq}. */
  id: string;
  /** Session ID. */
  sessionId: string;
  /** Original sensitive content (stored encrypted). */
  original: string;
  /** Replacement content. */
  replacement: string;
  /** Privacy type. */
  type: string;
  /** Risk level. */
  riskLevel: RiskLevel;
  /** Creation timestamp (ms). */
  createdAt: number;
}

/** Context for privacy filtering within a session. */
export interface PrivacyContext {
  /** Session ID for mapping isolation. */
  sessionId: string;
  /** Whether privacy filtering is enabled. */
  enabled: boolean;
}

/** Privacy module configuration. */
export interface PrivacyConfig {
  /** Enable/disable privacy filtering. */
  enabled: boolean;
  /** Rule set: "basic", "extended", or a custom path. */
  rules: string;
  /** Encryption settings. */
  encryption: {
    /** Encryption algorithm. */
    algorithm: string;
    /** User-provided salt (empty = auto-generate). */
    salt: string;
  };
  /** Mapping store settings. */
  mappings: {
    /** TTL in ms (default 24h). */
    ttl: number;
    /** Custom store path. */
    storePath: string;
  };
  /** Logging settings. */
  log: {
    /** Use replaced content in logs. */
    useReplacedContent: boolean;
  };
}

/** Default privacy configuration. */
export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  enabled: true,
  rules: "extended",
  encryption: {
    algorithm: "aes-256-gcm",
    salt: "",
  },
  mappings: {
    ttl: 86_400_000,
    storePath: "",
  },
  log: {
    useReplacedContent: true,
  },
};

/**
 * A privacy rule as expressed in a user JSON5 config file.
 * Does not include `validate` (functions can't be serialized).
 */
export interface UserDefinedRule {
  /** Privacy type identifier — must match [a-z][a-z0-9_]* */
  type: string;
  /** Human-readable description. */
  description: string;
  /** Whether this rule is enabled. Defaults to true. */
  enabled?: boolean;
  /** Risk level. */
  riskLevel: RiskLevel;
  /** Regex pattern string. */
  pattern?: string;
  /** Keyword list for keyword-based matching. */
  keywords?: string[];
  /** Whether keyword matching is case-sensitive. */
  caseSensitive?: boolean;
  /** Context constraints. */
  context?: RuleContext;
  /**
   * Named built-in validator function.
   * Supported: "bare_password" | "high_entropy"
   */
  validateFn?: string;
  /** Custom replacement template string. Supports placeholders: {type}, {seq}, {ts}, {original_prefix:N}, {original_length}, {pad:N}. */
  replacementTemplate?: string;
}

/** Top-level structure of a custom privacy rules JSON5 file. */
export interface CustomRulesConfig {
  /** Base preset to extend. Default: "extended". */
  extends?: "basic" | "extended" | "none";
  /** Rules to add or override. */
  rules: UserDefinedRule[];
  /** Rule types to explicitly disable from the base preset. */
  disable?: string[];
}
