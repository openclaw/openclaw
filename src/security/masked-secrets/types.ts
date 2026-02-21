/**
 * Masked Secrets — Type Definitions
 *
 * Core types for the masked secrets system. Allows agents to *use* secrets
 * (API keys, tokens) without being able to *see* them in plaintext.
 *
 * @see https://github.com/openclaw/openclaw/issues/10659
 */

/** A single masked secret entry */
export type MaskedSecret = {
  /** Display name used in {{secret:NAME}} references */
  name: string;
  /** The actual secret value (never exposed to the agent) */
  value: string;
  /** Where the secret was loaded from */
  source: "env" | "dotenv" | "config" | "keychain";
  /** Optional description for the secret (shown to agent instead of value) */
  description?: string;
};

/** Configuration for the masked secrets system */
export type MaskedSecretsConfig = {
  /** Whether the system is enabled (default: true) */
  enabled: boolean;

  /**
   * List of secret names to mask. Can be:
   * - Exact env var names: "MY_API_KEY"
   * - Glob patterns: "OPENAI_*"
   * - Auto-detect mode: if empty, auto-detects common patterns
   */
  mask: string[];

  /**
   * Additional patterns to detect secrets in command output.
   * These are regex patterns matched against stdout/stderr.
   * Built-in patterns cover common API key formats.
   */
  outputPatterns?: string[];

  /**
   * Commands that are blocked entirely because they expose env vars.
   * Default: ["env", "printenv", "set", "export"]
   */
  blockedCommands?: string[];

  /**
   * Whether to block `cat`/`less`/`head` etc. on known secret files.
   * Default: true
   */
  blockSecretFileReads?: boolean;

  /**
   * Paths considered secret files (blocked from direct reads).
   * Default: [".env", "*.key", "*.pem", "credentials.json", "auth-profiles.json"]
   */
  secretFilePaths?: string[];
};

/** Result of a secret substitution attempt */
export type SubstitutionResult = {
  /** The command/text with secrets substituted */
  text: string;
  /** Names of secrets that were substituted */
  substituted: string[];
  /** Names referenced but not found */
  missing: string[];
};

/** Result of output redaction */
export type RedactionResult = {
  /** The output with secrets redacted */
  text: string;
  /** Number of redactions performed */
  count: number;
  /** Which secrets were found in the output */
  redactedSecrets: string[];
};

/** Pre-execution check result */
export type PreflightResult = {
  /** Whether the command is allowed to execute */
  allowed: boolean;
  /** If blocked, the reason why */
  reason?: string;
  /** The command after secret substitution (if allowed) */
  processedCommand?: string;
  /** Warnings (non-blocking) */
  warnings?: string[];
};
