/**
 * Privacy Shield - Scans and redacts PII (Personally Identifiable Information)
 * from agent context before sending it to LLMs.
 */

import { loadConfig } from "../config/config.js";

export interface PiiRedactor {
  name: string;
  pattern: RegExp;
  replace: string;
}

const DEFAULT_PII_RED_LIST: PiiRedactor[] = [
  {
    name: "Email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replace: "[EMAIL_REDACTED]",
  },
  {
    name: "Phone",
    // Matches common phone formats: +1-202-555-0123, (202) 555-0123, 13812345678, etc.
    pattern: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4,6}/g,
    replace: "[PHONE_REDACTED]",
  },
  {
    name: "Credit Card",
    pattern: /\b(?:\d[ -]*?){13,16}\b/g,
    replace: "[CREDIT_CARD_REDACTED]",
  },
  {
    name: "IPv4",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replace: "[IP_REDACTED]",
  },
];

/**
 * Scrub PII from a string.
 */
export function scrubPII(text: string, customPatterns?: string[]): string {
  if (!text) {
    return text;
  }

  let scrubbed = text;

  // Apply default patterns
  for (const redactor of DEFAULT_PII_RED_LIST) {
    scrubbed = scrubbed.replace(redactor.pattern, redactor.replace);
  }

  // Apply custom patterns from config
  if (customPatterns) {
    for (const patternStr of customPatterns) {
      try {
        const re = new RegExp(patternStr, "gi");
        scrubbed = scrubbed.replace(re, "[REDACTED]");
      } catch {
        // ignore invalid regex
      }
    }
  }

  return scrubbed;
}

/**
 * Enhanced scrubbing that checks config.
 */
export function scrubPIIWithConfig(text: string): string {
  try {
    const config = loadConfig();
    const privacy = config.security?.privacy;

    if (privacy?.piiScrubbing === "on") {
      return scrubPII(text, privacy.piiPatterns);
    }
  } catch {
    // Fallback if config can't be loaded
  }

  return text;
}

/**
 * Scrub PII in a list of agent messages.
 */
export function scrubPIIInMessages<T>(messages: T[]): T[] {
  try {
    const config = loadConfig();
    const privacy = config.security?.privacy;

    if (privacy?.piiScrubbing !== "on") {
      return messages;
    }

    const patterns = privacy.piiPatterns;

    return messages.map((msg) => {
      if (!msg || typeof msg !== "object") {
        return msg;
      }

      const next = { ...(msg as Record<string, unknown>) };
      if (typeof next.content === "string") {
        next.content = scrubPII(next.content, patterns);
      } else if (Array.isArray(next.content)) {
        next.content = next.content.map((block: unknown) => {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              return { ...b, text: scrubPII(b.text, patterns) };
            }
          }
          return block;
        });
      }

      // Also check top-level 'text' property which some message types use
      if (typeof next.text === "string") {
        next.text = scrubPII(next.text, patterns);
      }

      return next as T;
    });
  } catch {
    return messages;
  }
}
