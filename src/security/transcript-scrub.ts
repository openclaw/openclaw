/**
 * Session transcript credential scrubbing.
 *
 * Scans tool call arguments for credential-like values before they
 * are persisted to session JSONL files. This prevents passwords and
 * API keys from being written to disk when the agent uses browser_fill
 * or similar tools with sensitive values.
 *
 * Designed for use as a before_message_write or tool_result_persist hook.
 */

const TOOL_ARG_CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{20,})\b/g,
  /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  /\b(ghp_[A-Za-z0-9]{20,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(xapp-[A-Za-z0-9-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z\-_]{20,})\b/g,
  /\b(\d{6,}:[A-Za-z0-9_-]{20,})\b/g,
];

const PASSWORD_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
]);

const REDACTED_PLACEHOLDER = "[REDACTED]";

export function scrubToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return scrubObject(args) as Record<string, unknown>;
}

function scrubObject(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubObject);
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (
        PASSWORD_FIELD_NAMES.has(key.toLowerCase()) &&
        typeof val === "string" &&
        val.length > 0
      ) {
        result[key] = REDACTED_PLACEHOLDER;
      } else {
        result[key] = scrubObject(val);
      }
    }
    return result;
  }
  return value;
}

function scrubString(text: string): string {
  let result = text;
  for (const pattern of TOOL_ARG_CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}

/**
 * Scrub browser fill/type tool args specifically.
 * When the browser tool is called with kind=fill or kind=type, the value
 * field may contain credentials that should not be persisted.
 */
export function scrubBrowserFillArgs(args: Record<string, unknown>): Record<string, unknown> {
  const request = args.request;
  if (!request || typeof request !== "object") {
    return scrubToolArgs(args);
  }

  const req = request as Record<string, unknown>;
  const kind = req.kind;

  if (kind === "fill" && Array.isArray(req.fields)) {
    const scrubbedFields = req.fields.map((field: unknown) => {
      if (field && typeof field === "object") {
        const f = field as Record<string, unknown>;
        if (typeof f.value === "string" && f.value.length > 0) {
          const isPasswordType = f.type === "password";
          const hasCredentialPattern = TOOL_ARG_CREDENTIAL_PATTERNS.some((p) => {
            p.lastIndex = 0;
            return p.test(String(f.value));
          });
          if (isPasswordType || hasCredentialPattern) {
            return { ...f, value: REDACTED_PLACEHOLDER };
          }
        }
      }
      return field;
    });
    return { ...args, request: { ...req, fields: scrubbedFields } };
  }

  if (kind === "type" && typeof req.text === "string") {
    const hasCredential = TOOL_ARG_CREDENTIAL_PATTERNS.some((p) => {
      p.lastIndex = 0;
      return p.test(String(req.text));
    });
    if (hasCredential) {
      return { ...args, request: { ...req, text: REDACTED_PLACEHOLDER } };
    }
  }

  return scrubToolArgs(args);
}
