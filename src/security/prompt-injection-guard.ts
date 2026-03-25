/**
 * Prompt Injection Security Middleware
 *
 * Sanitizes user input to prevent prompt injection attacks
 */

// Blocked patterns for prompt injection attempts
const BLOCKED_PATTERNS = [
  /ignore.*previous.*instruction/gi,
  /ignore.*system.*prompt/gi,
  /system.*override/gi,
  /you are now/gi,
  /DAN|jailbreak/gi,
  /\[system\]/gi,
  /\[admin\]/gi,
  /new instructions/gi,
  /disregard.*above/gi,
  /forget.*prompt/gi,
];

// Control characters and delimiters to strip (intentional control-char matching)
// oxlint-disable-next-line no-control-regex
const DANGEROUS_CHARS = /[\u0000-\u001F\u007F\u200B-\u200D\uFEFF\\`[\]]/g;

/**
 * Sanitize user input before processing
 */
export function sanitizeInput(input: string): {
  sanitized: string;
  blocked: boolean;
  reason?: string;
} {
  // Check for blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(input)) {
      return {
        sanitized: "",
        blocked: true,
        reason: `Blocked pattern detected: ${pattern.source}`,
      };
    }
  }

  // Strip dangerous characters
  const sanitized = input.replace(DANGEROUS_CHARS, "");

  // Check for excessive length (potential DoS)
  if (input.length > 50000) {
    return {
      sanitized: sanitized.slice(0, 50000),
      blocked: false,
      reason: "Input truncated (excessive length)",
    };
  }

  return { sanitized, blocked: false };
}

/**
 * Validate that output doesn't leak system prompts
 */
export function validateOutput(
  output: string,
  systemPrompt: string,
): { valid: boolean; reason?: string } {
  // Check if output contains system prompt content
  const systemChunks = systemPrompt.split("\n").filter((line) => line.length > 20);

  for (const chunk of systemChunks) {
    if (output.includes(chunk)) {
      return {
        valid: false,
        reason: "Output contains system prompt content",
      };
    }
  }

  // Check for common leak patterns
  const leakPatterns = [
    /system prompt:/gi,
    /my instructions are:/gi,
    /i am an ai assistant configured to/gi,
  ];

  for (const pattern of leakPatterns) {
    if (pattern.test(output)) {
      return {
        valid: false,
        reason: "Potential system prompt leak detected",
      };
    }
  }

  return { valid: true };
}

/**
 * Rate limiting for suspicious activity.
 * Includes periodic cleanup to prevent unbounded memory growth.
 */
export class RateLimiter {
  private attempts = new Map<string, { count: number; lastReset: number }>();
  private readonly maxAttempts = 5;
  private readonly windowMs = 60000; // 1 minute
  private readonly cleanupIntervalMs = 300000; // 5 minutes
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanup();
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    const record = this.attempts.get(key);

    if (!record || now - record.lastReset > this.windowMs) {
      this.attempts.set(key, { count: 1, lastReset: now });
      return true;
    }

    if (record.count >= this.maxAttempts) {
      return false;
    }

    record.count++;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.attempts) {
      if (now - record.lastReset > this.windowMs) {
        this.attempts.delete(key);
      }
    }
  }

  private startCleanup(): void {
    if (this.cleanupTimer) {
      return;
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    this.cleanupTimer.unref(); // Don't keep process alive for cleanup
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.attempts.clear();
  }
}

export const inputSanitizer = { sanitizeInput, validateOutput, RateLimiter };
