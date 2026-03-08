/**
 * Smart Debounce - Dynamic debounce based on message completeness detection
 *
 * This module provides intelligent message batching by analyzing message content
 * to determine if the user is still typing or has finished their input.
 */

/**
 * Configuration for smart debounce behavior
 */
export interface SmartDebounceConfig {
  /** Enable smart debounce (default: true) */
  enabled: boolean;
  /** Signals that indicate incomplete input */
  incompleteSignals: string[];
  /** Signals that indicate complete input */
  completeSignals: string[];
  /** Multiplier applied when message appears incomplete (default: 1.5) */
  incompleteMultiplier: number;
  /** Multiplier applied when message appears complete (default: 0.7) */
  completeMultiplier: number;
  /** Minimum message length to analyze (default: 3) */
  minMessageLength: number;
  /** Maximum multiplier cap (default: 3.0) */
  maxMultiplier: number;
}

/**
 * Default configuration for smart debounce
 */
export const DEFAULT_SMART_DEBOUNCE_CONFIG: SmartDebounceConfig = {
  enabled: true,
  incompleteSignals: ["...", "，", ",", "、", "待续", "continue", "还有", "and"],
  completeSignals: ["。", "？", "?", "！", "!", " done", " 完了", " 就这些", "好了", "."],
  incompleteMultiplier: 1.5,
  completeMultiplier: 0.7,
  minMessageLength: 3,
  maxMultiplier: 3.0,
};

/**
 * Check if a message appears to be incomplete
 */
export function isIncompleteMessage(
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): boolean {
  const trimmed = message.trim();

  // Too short to determine
  if (trimmed.length < config.minMessageLength) {
    return true;
  }

  // Check for incomplete signals
  for (const signal of config.incompleteSignals) {
    if (trimmed.endsWith(signal)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a message appears to be complete
 */
export function isCompleteMessage(
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): boolean {
  const trimmed = message.trim();

  // Check for complete signals
  for (const signal of config.completeSignals) {
    if (trimmed.endsWith(signal)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate dynamic debounce multiplier based on message analysis
 *
 * @param message - The message text to analyze
 * @param config - Smart debounce configuration
 * @returns Multiplier to apply to base debounce time
 */
export function calculateDebounceMultiplier(
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): number {
  if (!config.enabled) {
    return 1.0;
  }

  const trimmed = message.trim();

  if (trimmed.length < config.minMessageLength) {
    return config.incompleteMultiplier;
  }

  if (isIncompleteMessage(trimmed, config)) {
    return Math.min(config.incompleteMultiplier, config.maxMultiplier);
  }

  if (isCompleteMessage(trimmed, config)) {
    return config.completeMultiplier;
  }

  return 1.0;
}

/**
 * Resolve smart debounce time based on message content
 *
 * @param baseDebounceMs - The base debounce time from config
 * @param message - The message text to analyze
 * @param config - Smart debounce configuration
 * @returns Adjusted debounce time in milliseconds
 */
export function resolveSmartDebounceMs(
  baseDebounceMs: number,
  message: string,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
): number {
  const multiplier = calculateDebounceMultiplier(message, config);
  const adjusted = Math.round(baseDebounceMs * multiplier);

  // Ensure minimum of 100ms and reasonable maximum
  return Math.max(100, Math.min(adjusted, 30000));
}

/**
 * Extract text from various message formats
 */
export function extractMessageText(item: unknown): string {
  if (!item) {
    return "";
  }

  // Handle object with text property
  if (typeof item === "object" && item !== null) {
    const obj = item as Record<string, unknown>;

    // Common text fields in order of precedence
    const textFields = ["text", "content", "body", "message", "caption"];

    for (const field of textFields) {
      const value = obj[field];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }

    // Handle nested msg object (Telegram style)
    if (obj.msg && typeof obj.msg === "object") {
      const msg = obj.msg as Record<string, unknown>;
      const text = msg.text ?? msg.caption;
      if (typeof text === "string") {
        return text;
      }
    }
  }

  // Handle string directly
  if (typeof item === "string") {
    return item;
  }

  return "";
}

/**
 * Create a smart debounce resolver function
 *
 * This returns a function that can be used as resolveDebounceMs callback
 * in createInboundDebouncer.
 *
 * @param baseDebounceMs - Base debounce time from config
 * @param config - Smart debounce configuration
 * @param extractText - Optional function to extract text from item
 * @returns Function that resolves debounce time for each item
 */
export function createSmartDebounceResolver<T>(
  baseDebounceMs: number,
  config: SmartDebounceConfig = DEFAULT_SMART_DEBOUNCE_CONFIG,
  extractText?: (item: T) => string,
): (item: T) => number {
  return (item: T): number => {
    const message = extractText ? extractText(item) : extractMessageText(item);
    return resolveSmartDebounceMs(baseDebounceMs, message, config);
  };
}
