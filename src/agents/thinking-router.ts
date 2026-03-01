/**
 * Dynamic thinking level router.
 * Analyzes incoming messages and determines optimal thinking level.
 *
 * @module thinking-router
 */

import type { ThinkLevel } from "../auto-reply/thinking.js";

export interface ThinkingRouterRule {
  match: {
    /** Keywords that trigger this rule (case-insensitive). */
    keywords?: string[];
    /** Minimum message length in characters. */
    minLength?: number;
    /** Maximum message length in characters. */
    maxLength?: number;
    /** Message contains code blocks. */
    hasCode?: boolean;
    /** Session type filter. */
    sessionType?: "main" | "subagent" | "cron";
    /** Regex pattern to match (string form). */
    pattern?: string;
  };
  /** Thinking level to apply when rule matches. */
  thinking: ThinkLevel;
  /** Higher priority rules are checked first (default: 0). */
  priority?: number;
}

export interface ThinkingRouterConfig {
  /** Enable dynamic thinking routing. */
  enabled?: boolean;
  /** Default thinking level when no rules match. */
  default: ThinkLevel;
  /** Routing rules (checked in priority order). */
  rules: ThinkingRouterRule[];
}

export interface ThinkingRouterContext {
  /** The user's message text. */
  message?: string;
  /** Session type (main, subagent, cron). */
  sessionType?: "main" | "subagent" | "cron";
  /** Number of recent tool calls in session. */
  recentToolCalls?: number;
}

// Pre-compiled regex cache for performance
const patternCache = new Map<string, RegExp>();

function getOrCreateRegex(pattern: string): RegExp | null {
  if (patternCache.has(pattern)) {
    return patternCache.get(pattern)!;
  }
  try {
    const regex = new RegExp(pattern, "i");
    patternCache.set(pattern, regex);
    return regex;
  } catch {
    return null;
  }
}

/**
 * High-value keywords that suggest complex reasoning tasks.
 * Used as default rules when no custom rules are configured.
 */
export const DEFAULT_HIGH_THINKING_KEYWORDS = [
  "architect",
  "architecture",
  "design",
  "implement",
  "debug",
  "analyze",
  "evaluate",
  "compare",
  "complex",
  "strategy",
  "optimize",
  "refactor",
  "migrate",
  "security",
  "performance",
];

export const DEFAULT_MEDIUM_THINKING_KEYWORDS = [
  "build",
  "create",
  "code",
  "write",
  "develop",
  "fix",
  "update",
  "modify",
  "change",
  "add",
  "remove",
  "test",
  "review",
];

/**
 * Default thinking router configuration.
 * Note: disabled by default for backward compatibility.
 */
export const DEFAULT_THINKING_ROUTER_CONFIG: ThinkingRouterConfig = {
  enabled: false,
  default: "low",
  rules: [
    {
      match: { keywords: DEFAULT_HIGH_THINKING_KEYWORDS },
      thinking: "high",
      priority: 100,
    },
    {
      match: { keywords: DEFAULT_MEDIUM_THINKING_KEYWORDS },
      thinking: "medium",
      priority: 80,
    },
    {
      match: { minLength: 500 },
      thinking: "medium",
      priority: 50,
    },
    {
      match: { hasCode: true },
      thinking: "medium",
      priority: 60,
    },
    {
      match: { sessionType: "subagent" },
      thinking: "high",
      priority: 90,
    },
  ],
};

/**
 * Check if a message contains code blocks.
 */
function hasCodeBlocks(message: string): boolean {
  // Fenced code blocks or inline code
  return /```[\s\S]*```|`[^`]+`/.test(message);
}

/**
 * Check if a rule matches the given context.
 */
function matchesRule(context: ThinkingRouterContext, match: ThinkingRouterRule["match"]): boolean {
  const message = context.message ?? "";
  const msgLower = message.toLowerCase();

  // Keyword matching (any keyword present = match)
  if (match.keywords?.length) {
    const hasKeyword = match.keywords.some((kw) => msgLower.includes(kw.toLowerCase()));
    if (!hasKeyword) {
      return false;
    }
  }

  // Message length bounds
  if (match.minLength !== undefined && message.length < match.minLength) {
    return false;
  }
  if (match.maxLength !== undefined && message.length > match.maxLength) {
    return false;
  }

  // Code detection
  if (match.hasCode !== undefined) {
    const messageHasCode = hasCodeBlocks(message);
    if (messageHasCode !== match.hasCode) {
      return false;
    }
  }

  // Session type
  if (match.sessionType && context.sessionType !== match.sessionType) {
    return false;
  }

  // Regex pattern (invalid patterns cause rule to not match)
  if (match.pattern) {
    const regex = getOrCreateRegex(match.pattern);
    if (!regex) {
      // Invalid regex pattern - rule cannot match
      return false;
    }
    if (!regex.test(message)) {
      return false;
    }
  }

  return true;
}

/**
 * Route thinking level based on message content and context.
 *
 * @param context - The routing context (message, session type, etc.)
 * @param config - Router configuration (rules, default level)
 * @returns The resolved thinking level
 */
export function routeThinkingLevel(
  context: ThinkingRouterContext,
  config: ThinkingRouterConfig,
): ThinkLevel {
  if (!config.enabled) {
    return config.default;
  }

  // Sort rules by priority (descending)
  const sortedRules = config.rules.toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const rule of sortedRules) {
    if (matchesRule(context, rule.match)) {
      return rule.thinking;
    }
  }

  return config.default;
}

/**
 * Quick heuristic check for high-complexity messages.
 * Used when full router config isn't available.
 *
 * @param message - The user's message
 * @returns Suggested thinking level based on heuristics
 */
export function quickRouteThinking(message: string): ThinkLevel | null {
  if (!message?.trim()) {
    return null;
  }

  const msgLower = message.toLowerCase();

  // Check for high-complexity keywords
  for (const kw of DEFAULT_HIGH_THINKING_KEYWORDS) {
    if (msgLower.includes(kw)) {
      return "high";
    }
  }

  // Check for medium-complexity keywords
  for (const kw of DEFAULT_MEDIUM_THINKING_KEYWORDS) {
    if (msgLower.includes(kw)) {
      return "medium";
    }
  }

  // Long messages likely need more thinking
  if (message.length > 500) {
    return "medium";
  }

  // Code blocks suggest technical work
  if (hasCodeBlocks(message)) {
    return "medium";
  }

  // No heuristic match - return null to use default
  return null;
}
