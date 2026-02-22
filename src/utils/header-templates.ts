/**
 * Resolves template placeholders in header values.
 * Supports {{sessionKey}} for per-conversation identifiers (e.g. for proxy sticky routing).
 *
 * @see https://github.com/openclaw/openclaw/issues/22885
 */
export function resolveHeaderTemplates(
  headers: Record<string, string>,
  vars: { sessionKey?: string | null },
): Record<string, string> {
  const resolved: Record<string, string> = {};
  const sessionKey = (vars.sessionKey ?? "").trim();

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      continue;
    }
    let out = value;
    if (out.includes("{{sessionKey}}")) {
      if (!sessionKey) {
        continue; // Skip headers that need sessionKey when none is available
      }
      out = out.replaceAll("{{sessionKey}}", sessionKey);
    }
    if (out.includes("{{")) {
      // Leave unresolved placeholders as-is to avoid breaking unknown templates
      continue;
    }
    resolved[key] = out;
  }

  return resolved;
}
