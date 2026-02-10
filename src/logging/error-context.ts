/**
 * Enhanced error context tracking
 * Adds session key, operation trace, and structured error information
 *
 * Uses AsyncLocalStorage for proper context isolation across concurrent
 * sessions and async operations.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type OperationContext = {
  sessionKey?: string;
  operation?: string;
  tool?: string;
  timestamp?: number;
  breadcrumbs?: string[];
};

export type ContextualError = {
  message: string;
  code?: string;
  context: OperationContext;
  originalError?: Error;
  sanitized?: boolean;
};

type ContextStore = {
  stack: OperationContext[];
};

const contextStorage = new AsyncLocalStorage<ContextStore>();

/**
 * Get or create the context store for the current async context
 */
function getStore(): ContextStore {
  const store = contextStorage.getStore();
  if (store) {
    return store;
  }

  // If no store exists (e.g., called outside runInContext), use an ephemeral one
  // This maintains backward compatibility but operations won't persist
  return { stack: [] };
}

/**
 * Run a function with isolated error context.
 * All operations inside the callback will use a separate context stack.
 */
export function runInContext<T>(fn: () => T): T {
  return contextStorage.run({ stack: [] }, fn);
}

/**
 * Run an async function with isolated error context.
 */
export async function runInContextAsync<T>(fn: () => Promise<T>): Promise<T> {
  return contextStorage.run({ stack: [] }, fn);
}

/**
 * Set the current operation context (for nested operations)
 */
export function pushOperation(ctx: Partial<OperationContext>): void {
  const store = getStore();
  store.stack.push({
    sessionKey: ctx.sessionKey,
    operation: ctx.operation,
    tool: ctx.tool,
    timestamp: ctx.timestamp ?? Date.now(),
    breadcrumbs: ctx.breadcrumbs ?? [],
  });
}

/**
 * Pop the current operation context
 */
export function popOperation(): OperationContext | undefined {
  const store = getStore();
  return store.stack.pop();
}

/**
 * Get the current operation context
 */
export function getCurrentOperation(): OperationContext | undefined {
  const store = getStore();
  return store.stack[store.stack.length - 1];
}

/**
 * Clear all operation contexts in the current async context
 */
export function clearOperationStack(): void {
  const store = getStore();
  store.stack.length = 0;
}

/**
 * Add a breadcrumb to the current operation
 */
export function addBreadcrumb(message: string): void {
  const current = getCurrentOperation();
  if (current) {
    current.breadcrumbs ??= [];
    current.breadcrumbs.push(`[${new Date().toISOString()}] ${message}`);
  }
}

// Patterns for actual secrets (targeted, not over-broad)
const SECRET_PATTERNS = [
  // URLs with sensitive query params
  /https?:\/\/[^\s]*[?&](token|key|secret|auth|password|api_key|apikey|access_token|bearer)[=][^\s&]*/gi,
  // File paths to sensitive files
  /\/[^\s]*(\/\.openclawrc|\.env|\.env\.[a-z]+|secrets?\.ya?ml|credentials)[^\s]*/gi,
  // Known token prefixes (API keys, JWTs, etc.)
  /\b(sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,})\b/g, // OpenAI-style keys
  /\b(ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,})\b/g, // GitHub tokens
  /\b(xox[baprs]-[a-zA-Z0-9-]+)\b/g, // Slack tokens
  /\b(eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+)\b/g, // JWTs
  /\b(AKIA[0-9A-Z]{16})\b/g, // AWS access keys
  /\b(bearer\s+[a-zA-Z0-9._~+/=-]{20,})\b/gi, // Bearer tokens
  /\b(password|passwd|pwd)\s*[:=]\s*["']?[^\s"']+["']?/gi, // Password assignments
  /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[^\s"']+["']?/gi, // API key assignments
];

/**
 * Sanitize an error for safe transmission (e.g., to Slack)
 * Only redacts actual secrets, not general identifiers like UUIDs or session keys.
 */
export function sanitizeError(err: Error | unknown): {
  message: string;
  sanitized: boolean;
} {
  const originalMessage = err instanceof Error ? err.message : String(err);
  let message = originalMessage;

  // Apply targeted secret patterns
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    message = message.replace(pattern, "[REDACTED]");
  }

  const sanitized = message !== originalMessage;

  return { message, sanitized };
}

/**
 * Create a contextual error with session and operation information
 */
export function createContextualError(
  message: string,
  options?: {
    code?: string;
    context?: Partial<OperationContext>;
    originalError?: Error;
  },
): ContextualError {
  const currentOperation = getCurrentOperation();
  const context: OperationContext = {
    sessionKey: options?.context?.sessionKey ?? currentOperation?.sessionKey,
    operation: options?.context?.operation ?? currentOperation?.operation,
    tool: options?.context?.tool ?? currentOperation?.tool,
    timestamp: options?.context?.timestamp ?? Date.now(),
    breadcrumbs: options?.context?.breadcrumbs ?? [...(currentOperation?.breadcrumbs ?? [])],
  };

  return {
    message,
    code: options?.code,
    context,
    originalError: options?.originalError,
    sanitized: false,
  };
}

/**
 * Format a contextual error for logging
 */
export function formatContextualError(err: ContextualError): string {
  const parts: string[] = [];

  if (err.context.sessionKey) {
    parts.push(`[${err.context.sessionKey.slice(0, 8)}]`);
  }

  if (err.context.operation) {
    parts.push(`{${err.context.operation}}`);
  }

  if (err.code) {
    parts.push(`ERR_${err.code}`);
  }

  parts.push(err.message);

  if (err.context.breadcrumbs && err.context.breadcrumbs.length > 0) {
    parts.push(`\nBreadcrumbs:\n${err.context.breadcrumbs.join("\n")}`);
  }

  return parts.join(" ");
}

/**
 * Sanitize a contextual error for safe Slack delivery
 */
export function sanitizeContextualErrorForSlack(err: ContextualError): ContextualError {
  const { message, sanitized: messageSanitized } = sanitizeError(new Error(err.message));

  // Also sanitize breadcrumbs
  let breadcrumbsSanitized = false;
  const sanitizedBreadcrumbs = (err.context.breadcrumbs ?? []).map((crumb) => {
    const { message: sanitizedMessage, sanitized } = sanitizeError(new Error(crumb));
    if (sanitized) {
      breadcrumbsSanitized = true;
    }
    return sanitizedMessage;
  });

  return {
    ...err,
    message,
    sanitized: messageSanitized || breadcrumbsSanitized,
    context: {
      ...err.context,
      breadcrumbs: sanitizedBreadcrumbs,
    },
  };
}
