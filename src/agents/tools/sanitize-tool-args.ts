import { logWarn } from "../../logger.js";
import type { AnyAgentTool } from "../pi-tools.types.js";
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

/**
 * Sanitize the given string keys on a params record. Returns a new record only
 * when something changed; otherwise the original. Shared by the path-like
 * (read/write/edit) and search-like (find/grep/ls) wrappers so the leak-strip
 * behavior stays identical across every file tool.
 */
function sanitizeRecordKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  toolName: string,
): Record<string, unknown> {
  let result = record;
  for (const key of keys) {
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

// Path-like keys carried by the core file tools (read/write/edit) after
// Claude-compat normalization. Content-bearing keys (content/oldText/newText)
// are intentionally excluded: file contents may legitimately contain `<|`,
// `<<`, quotes, etc. and must not be mutated.
const PATH_LIKE_KEYS = ["path", "file_path"] as const;

// Search/list tool string args (find/grep/ls). These bypass
// normalizeToolParams (no Claude-compat alias remapping) so they need their
// own sanitize entry point. `pattern`/`glob` are search inputs: a leaked
// sentinel prefix (`<|<|"foo`) makes the search silently miss and the model
// then hallucinates a result — strip the same tokens as for bash/path args.
// Content-bearing keys stay excluded for the same reason as PATH_LIKE_KEYS.
const SEARCH_LIKE_KEYS = ["path", "file_path", "pattern", "glob"] as const;

/**
 * Sanitize path-like string params on a normalized file-tool params record.
 * Returns a new record only when something changed; otherwise the original.
 */
export function sanitizeFileToolParams(
  record: Record<string, unknown>,
  toolName = "file",
): Record<string, unknown> {
  return sanitizeRecordKeys(record, PATH_LIKE_KEYS, toolName);
}

/**
 * Sanitize string params on a find/grep/ls params record.
 * Returns a new record only when something changed; otherwise the original.
 */
export function sanitizeSearchToolParams(
  record: Record<string, unknown>,
  toolName = "search",
): Record<string, unknown> {
  return sanitizeRecordKeys(record, SEARCH_LIKE_KEYS, toolName);
}

/**
 * Wrap a search/list tool (find/grep/ls) so leaked LLM sentinel tokens are
 * stripped from its path/pattern/glob args before execution. Mirrors the
 * read/write/edit protection in pi-tools.params.ts for tools that skip
 * normalizeToolParams. No-op for clean args.
 */
export function wrapSearchToolArgSanitization(tool: AnyAgentTool): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const sanitized =
        params && typeof params === "object"
          ? sanitizeSearchToolParams(params as Record<string, unknown>, tool.name)
          : params;
      return tool.execute(toolCallId, sanitized ?? params, signal, onUpdate);
    },
  };
}
