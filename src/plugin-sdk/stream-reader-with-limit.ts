/**
 * Streaming-body SSE/NDJSON byte-cap guard, re-exported from core.
 *
 * Mirrors the `openclaw/plugin-sdk/provider-http` (re-exports
 * `readProviderJsonResponse` from `src/agents/provider-http-errors.ts`) pattern:
 * the implementation lives in core (`src/agents/streaming-byte-guard.ts`); this
 * SDK subpath is a thin re-export so extensions (`extensions/google`,
 * `extensions/ollama`, ...) can consume the helper without reaching into
 * `src/agents/**`, which the `src/plugin-sdk/CLAUDE.md` boundary forbids.
 */
export {
  createSseByteGuard,
  type ReadSseStreamWithLimitOptions,
  type SseByteGuard,
  type SseStreamOverflow,
} from "../agents/streaming-byte-guard.js";
