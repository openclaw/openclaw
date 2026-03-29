/**
 * Observability types — LLM usage events.
 * All fields flat (top-level) for Logstash compatibility.
 */
export interface LlmEventPayload {
  event: 'llm_event';
  level: 'info' | 'error';
  /** Always "openclaw" — required for Logstash routing */
  type: 'openclaw';
  /** ISO-8601 timestamp stamped at emission */
  time: string;
  /** Caller session key; fallback: 'unknown' */
  sessionKey: string;
  /** Model identifier from API response (e.g. "claude-sonnet-4-6-20250613") */
  model: string;
  /** Provider identifier (e.g. "anthropic", "google-gemini-cli") */
  provider: string;
  /** Input token count — omit entirely if 0 */
  tokens_in?: number;
  /** Output token count — omit entirely if 0 */
  tokens_out?: number;
  /** Wall-clock duration from request dispatch to final response/error */
  duration_ms: number;
  /** Error classifier — present only when level === 'error' */
  error_type?: string;
  /** Human-readable error message (<=500 chars) — present only when level === 'error' */
  error_message?: string;
}
