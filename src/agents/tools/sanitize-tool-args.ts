import { logWarn } from "../../logger.js";
import { sanitizeCommandInput } from "./sanitize-command.js";

/**
 * Generic sanitize for file-tool string args (path / file_path).
 *
 * Some smaller models (Gemma 4, etc.) leak LLM sentinel tokens such as
 * `<<|"|https://...` into tool call arguments. For bash exec we already
 * sanitize the command; for `read`/`write`/`edit` the leaked token landed in
 * `file_path`, producing an `ENOENT .../workspace/<|<|` error that the model
 * then hallucinated a success around (incident 2026-05-17 11:13 KST).
 *
 * Reuses the same sentinel-stripping library as bash exec. No-op for clean
 * input. Non-string args are returned unchanged.
 *
 * Logged via `logWarn` mirroring the bash exec pattern:
 *   `tool.sanitize_special_tokens tool=<name> arg=<name> original_len=.. sanitized_len=..`
 */
export function sanitizeToolArg(raw: unknown, toolName: string, argName: string): unknown {
  if (typeof raw !== "string") {
    return raw;
  }
  const cleaned = sanitizeCommandInput(raw);
  if (cleaned !== raw) {
    logWarn(
      `tool.sanitize_special_tokens tool=${toolName} arg=${argName} original_len=${raw.length} sanitized_len=${typeof cleaned === "string" ? cleaned.length : 0}`,
    );
  }
  return cleaned;
}

// Path-like keys carried by the core file tools (read/write/edit) after
// Claude-compat normalization. Content-bearing keys (content/oldText/newText)
// are intentionally excluded: file contents may legitimately contain `<|`,
// `<<`, quotes, etc. and must not be mutated.
const PATH_LIKE_KEYS = ["path", "file_path"] as const;

/**
 * Sanitize path-like string params on a normalized file-tool params record.
 * Returns a new record only when something changed; otherwise the original.
 */
export function sanitizeFileToolParams(
  record: Record<string, unknown>,
  toolName = "file",
): Record<string, unknown> {
  let result = record;
  for (const key of PATH_LIKE_KEYS) {
    if (!(key in result)) {
      continue;
    }
    const current = result[key];
    const next = sanitizeToolArg(current, toolName, key);
    if (next !== current) {
      if (result === record) {
        result = { ...record };
      }
      result[key] = next;
    }
  }
  return result;
}
