/** Blocks provider fallback when tool args contain sensitive credential patterns. */
import { logVerbose } from "../globals.js";
import { getDefaultRedactPatterns, redactSensitiveText } from "../logging/redact.js";
import type { WebFetchProviderToolDefinition } from "../plugins/types.js";

const EGRESS_FILTER_REDACT_OPTIONS = {
  mode: "tools" as const,
  patterns: getDefaultRedactPatterns(),
};

const WEB_FETCH_EGRESS_BLOCKED_MESSAGE =
  "web_fetch provider fallback blocked: sensitive credential pattern detected in tool arguments";

type WebFetchEgressFilterConfig = {
  enableEgressFilter?: boolean;
};

/** Resolves whether provider fallback args are scanned before outbound requests. Default: true. */
export function resolveWebFetchEgressFilterEnabled(fetch?: WebFetchEgressFilterConfig): boolean {
  if (typeof fetch?.enableEgressFilter === "boolean") {
    return fetch.enableEgressFilter;
  }
  return true;
}

function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringValues(entry, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      collectStringValues(entry, out);
    }
  }
}

/** Returns true when text matches built-in sensitive credential redaction patterns. */
export function containsSensitiveEgressContent(text: string): boolean {
  if (!text) {
    return false;
  }
  return redactSensitiveText(text, EGRESS_FILTER_REDACT_OPTIONS) !== text;
}

/** Throws when serialized tool args contain sensitive credential patterns. */
export function assertWebFetchArgsSafeForEgress(args: Record<string, unknown>): void {
  const strings: string[] = [];
  collectStringValues(args, strings);
  for (const value of strings) {
    if (!containsSensitiveEgressContent(value)) {
      continue;
    }
    logVerbose("web_fetch: blocked provider fallback due to sensitive credential pattern in args");
    throw new Error(WEB_FETCH_EGRESS_BLOCKED_MESSAGE);
  }
}

/** Wraps a provider tool execute handler with optional outbound credential scanning. */
export function wrapWebFetchProviderToolWithEgressFilter(
  definition: WebFetchProviderToolDefinition,
  enabled: boolean,
): WebFetchProviderToolDefinition {
  if (!enabled) {
    return definition;
  }
  return {
    ...definition,
    execute: async (args) => {
      assertWebFetchArgsSafeForEgress(args);
      return definition.execute(args);
    },
  };
}
