/**
 * LLM Response Extraction Types
 *
 * Type definitions for configuration-driven LLM response extraction from terminal output.
 * Supports multiple LLM terminals (Claude Code, Codex, etc.) via pattern-based configuration.
 */

/**
 * Pattern type for matching UI noise and boundaries in terminal output
 */
export type NoisePatternType = "prefix" | "regex" | "separator" | "context_hint";

/**
 * Configuration for a single noise pattern
 */
export interface NoisePattern {
  /** Type of pattern matching to use */
  type: NoisePatternType;
  /** For prefix type: exact string to match at line start */
  value?: string;
  /** For regex type: regex pattern string */
  pattern?: string;
  /** For separator type: characters that constitute a separator */
  chars?: string;
  /** Human-readable description of what this pattern matches */
  description?: string;
}

/**
 * Special handling configuration for LLM-specific behaviors
 */
export interface SpecialHandling {
  /** Configuration for handling command output blocks (e.g., Codex) */
  command_blocks?: {
    /** Whether command block handling is enabled */
    enabled: boolean;
    /** Description of the special handling */
    description?: string;
    /** Skip content between separators */
    skip_between_separators?: boolean;
  };
  [key: string]: unknown;
}

/**
 * Complete configuration for an LLM terminal's response extraction
 */
export interface LLMConfig {
  /** Unique name/identifier for this LLM */
  name: string;
  /** Schema version for config evolution */
  schema_version?: number;
  /** Human-readable description */
  description?: string;
  /** Symbol/string that marks the start of an LLM response */
  response_marker: string;
  /** Symbol/string that marks a user prompt */
  prompt_marker: string;
  /** Regex pattern for echo content to strip (e.g., health checks) */
  echo_pattern?: string;
  /** Number of spaces used for response indentation */
  indentation?: number;
  /** Patterns that mark boundaries where extraction should stop */
  stop_patterns: NoisePattern[];
  /** Patterns for UI noise to filter from extracted responses */
  noise_patterns: NoisePattern[];
  /** LLM-specific special handling rules */
  special_handling?: SpecialHandling;
}

/**
 * Extraction quality metrics for monitoring and debugging
 */
export interface ExtractionMetrics {
  /** LLM type that was used for extraction */
  llmType: string;
  /** Whether a response was found */
  responseFound: boolean;
  /** Length of extracted response in characters */
  responseLength: number;
  /** Number of lines extracted from terminal output */
  linesExtracted: number;
  /** Number of noise lines filtered out */
  noiseLinesFiltered: number;
  /** Time taken for extraction in milliseconds */
  extractionTimeMs: number;
  /** Whether the extracted response passed validation */
  validationPassed: boolean;
  /** Optional validation failure reason */
  validationFailure?: string;
}

/**
 * Error codes for extraction failures
 */
export enum ExtractionErrorCode {
  /** Configuration file not found for specified LLM type */
  CONFIG_NOT_FOUND = "CONFIG_NOT_FOUND",
  /** Configuration file is invalid/malformed */
  INVALID_CONFIG = "INVALID_CONFIG",
  /** No response marker found in terminal output */
  NO_RESPONSE_FOUND = "NO_RESPONSE_FOUND",
  /** Extraction succeeded but validation failed */
  VALIDATION_FAILED = "VALIDATION_FAILED",
  /** Terminal output appears malformed */
  MALFORMED_OUTPUT = "MALFORMED_OUTPUT",
}

/**
 * Typed error for extraction failures with recovery guidance
 */
export class ExtractionError extends Error {
  constructor(
    message: string,
    public code: ExtractionErrorCode,
    public recoverable: boolean,
    public rawOutput?: string,
  ) {
    super(message);
    this.name = "ExtractionError";

    // Maintain proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ExtractionError);
    }
  }
}

/**
 * Result of an extraction operation
 */
export interface ExtractionResult {
  /** Extracted response text, or null if no response found */
  response: string | null;
  /** Metrics about the extraction */
  metrics: ExtractionMetrics;
  /** Optional error if extraction failed */
  error?: ExtractionError;
}
