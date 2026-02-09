/**
 * Discord Bridge Integration Helpers
 *
 * Helper functions for using the extraction system in Discord bridge context.
 * Provides simple API for agents and infrastructure-level backup extraction.
 */

import { LLMResponseExtractor } from "./extractor.js";
import { ConfigLoader } from "./config-loader.js";
import type { ExtractionResult } from "./types.js";

// Simple logger for extraction integration
// TODO: Replace with proper structured logging infrastructure
const logger = {
  debug: (event: string, context: any) => {
    if (process.env.DEBUG) {
      console.debug(`[extraction-integration] ${event}`, context);
    }
  },
  info: (event: string, context: any) => {
    console.info(`[extraction-integration] ${event}`, context);
  },
  warn: (event: string, context: any) => {
    console.warn(`[extraction-integration] ${event}`, context);
  },
  error: (event: string, context: any) => {
    console.error(`[extraction-integration] ${event}`, context);
  },
};

/**
 * Maximum input size for extraction (1MB)
 * Prevents performance issues on huge PTY output
 */
export const MAX_EXTRACTION_SIZE = 1024 * 1024; // 1MB

/**
 * Detect LLM type from command string or output content
 * Uses heuristic approach - not guaranteed accurate
 *
 * @param command - Command that spawned the process (optional)
 * @param output - Terminal output to analyze (optional)
 * @returns Detected LLM type or 'default'
 */
export function detectLLMType(command?: string, output?: string): string {
  // Check output for markers (most reliable)
  if (output) {
    if (output.includes("⏺")) return "claude-code";
    if (output.includes("•")) return "codex";
  }

  // Fall back to command analysis
  if (command) {
    const lower = command.toLowerCase();
    if (lower.includes("claude") || lower.includes("moltbot")) return "claude-code";
    if (lower.includes("codex") || lower.includes("aider")) return "codex";
  }

  return "default";
}

/**
 * Extract LLM response or fall back to raw output
 *
 * @param rawOutput - Raw terminal output
 * @param llmType - LLM type (or auto-detect if not provided)
 * @param options - Extraction options
 * @returns Extraction result with clean text
 */
export function extractOrFallback(
  rawOutput: string,
  llmType?: string,
  options: {
    fallbackToRaw?: boolean;
    command?: string;
  } = {},
): {
  text: string;
  extracted: boolean;
  metrics?: ExtractionResult["metrics"];
  error?: string;
} {
  const { fallbackToRaw = true, command } = options;

  // Size check - prevent performance issues
  if (rawOutput.length > MAX_EXTRACTION_SIZE) {
    logger.warn("extraction_skipped_size", {
      size: rawOutput.length,
      maxSize: MAX_EXTRACTION_SIZE,
    });

    return {
      text: rawOutput,
      extracted: false,
      error: `Output too large (${rawOutput.length} bytes, max ${MAX_EXTRACTION_SIZE})`,
    };
  }

  // Detect LLM type if not provided
  const detectedType = llmType ?? detectLLMType(command, rawOutput);

  logger.debug("extraction_attempt", {
    llmType: detectedType,
    outputLength: rawOutput.length,
    wasProvided: !!llmType,
  });

  try {
    // Load config and create extractor
    const config = ConfigLoader.load(detectedType);
    const extractor = new LLMResponseExtractor(config);

    // Attempt extraction
    const result = extractor.extract(rawOutput);

    if (result.response) {
      logger.info("extraction_succeeded", {
        llmType: detectedType,
        originalLength: rawOutput.length,
        extractedLength: result.response.length,
        extractionTimeMs: result.metrics.extractionTimeMs,
      });

      return {
        text: result.response,
        extracted: true,
        metrics: result.metrics,
      };
    }

    // No response found
    logger.info("extraction_no_response", {
      llmType: detectedType,
      outputLength: rawOutput.length,
    });

    if (fallbackToRaw) {
      return {
        text: rawOutput,
        extracted: false,
        error: "No response marker found",
      };
    }

    return {
      text: "",
      extracted: false,
      error: "No response marker found",
    };
  } catch (error) {
    logger.error("extraction_failed", {
      llmType: detectedType,
      error: String(error),
      outputLength: rawOutput.length,
    });

    if (fallbackToRaw) {
      return {
        text: rawOutput,
        extracted: false,
        error: String(error),
      };
    }

    throw error;
  }
}

/**
 * Check if text looks like raw PTY output (contains terminal markers)
 * Used by infrastructure-level backup extraction
 *
 * @param text - Text to analyze
 * @returns True if text appears to be raw PTY output
 */
export function looksLikeRawPTYOutput(text: string): boolean {
  // Safe markers (unicode symbols unique to terminal output)
  const safeMarkers = ["⏺", "•", "●", "⏵⏵", "───", "═══"];
  if (safeMarkers.some((marker) => text.includes(marker))) {
    return true;
  }

  // Prompts only at start of line (avoid false positives like "Price: $50")
  if (/^[>$]\s/m.test(text)) {
    return true;
  }

  return false;
}

/**
 * Infrastructure-level backup extraction
 * Called by Discord delivery if agent didn't extract
 *
 * @param text - Text to potentially extract from
 * @param metadata - Optional context (command, session info)
 * @returns Extraction result
 */
export function backupExtraction(
  text: string,
  metadata?: {
    command?: string;
    wasExtracted?: boolean;
  },
): {
  text: string;
  extracted: boolean;
  wasBackup: boolean;
} {
  // Skip if already extracted
  if (metadata?.wasExtracted) {
    return {
      text,
      extracted: false,
      wasBackup: false,
    };
  }

  // Skip if doesn't look like PTY output
  if (!looksLikeRawPTYOutput(text)) {
    return {
      text,
      extracted: false,
      wasBackup: false,
    };
  }

  logger.info("backup_extraction_attempt", {
    textLength: text.length,
    command: metadata?.command,
  });

  // Try extraction with auto-detected LLM type
  const result = extractOrFallback(text, undefined, {
    fallbackToRaw: true,
    command: metadata?.command,
  });

  if (result.extracted) {
    logger.info("backup_extraction_succeeded", {
      originalLength: text.length,
      extractedLength: result.text.length,
    });
  }

  return {
    text: result.text,
    extracted: result.extracted,
    wasBackup: true,
  };
}
