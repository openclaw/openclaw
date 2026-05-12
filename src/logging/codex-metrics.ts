// Process-local counters for the codex (OpenAI Responses) transport.
// Exposed by the gateway HTTP server as a Prometheus text exposition under
// `/metrics`. Counters reset on process restart by design — rate-of-change
// is what dashboards care about, not lifetime totals.

interface CodexUsageRecord {
  prompt: number;
  completion: number;
  cached: number;
}

// Extract a privacy-safe command tag from a user message — the leading
// slash-command identifier ("/eth", "/scan") or "freeform" when the message
// starts with arbitrary text. The raw prompt is intentionally NOT exported
// for logging because pasted tokens, OAuth secrets, or customer identifiers
// must not leak into operational telemetry. Identifier is hard-capped to 31
// characters even if the message keeps going so long pasted blobs that begin
// with `/` cannot smuggle data through the tag.
export function extractCommandTag(content: unknown): string {
  if (typeof content !== "string") return "n/a";
  const match = content.trimStart().match(/^\/([a-z][a-z0-9_-]{0,30})/i);
  return match ? `/${match[1].toLowerCase()}` : "freeform";
}

let promptTokensTotal = 0;
let completionTokensTotal = 0;
let cachedTokensTotal = 0;
let requestsTotal = 0;

export function recordCodexUsage(record: CodexUsageRecord): void {
  promptTokensTotal += Math.max(0, record.prompt);
  completionTokensTotal += Math.max(0, record.completion);
  cachedTokensTotal += Math.max(0, record.cached);
  requestsTotal += 1;
}

export function resetCodexMetrics(): void {
  promptTokensTotal = 0;
  completionTokensTotal = 0;
  cachedTokensTotal = 0;
  requestsTotal = 0;
}

export function formatCodexMetricsPrometheus(): string {
  return [
    "# HELP openclaw_codex_prompt_tokens_total Total prompt tokens consumed by the codex transport since process start.",
    "# TYPE openclaw_codex_prompt_tokens_total counter",
    `openclaw_codex_prompt_tokens_total ${promptTokensTotal}`,
    "# HELP openclaw_codex_completion_tokens_total Total completion tokens emitted by the codex transport since process start.",
    "# TYPE openclaw_codex_completion_tokens_total counter",
    `openclaw_codex_completion_tokens_total ${completionTokensTotal}`,
    "# HELP openclaw_codex_cached_tokens_total Total cached prompt tokens reported by the codex transport since process start.",
    "# TYPE openclaw_codex_cached_tokens_total counter",
    `openclaw_codex_cached_tokens_total ${cachedTokensTotal}`,
    "# HELP openclaw_codex_requests_total Codex transport request count (one per completed responses.completed event).",
    "# TYPE openclaw_codex_requests_total counter",
    `openclaw_codex_requests_total ${requestsTotal}`,
    "",
  ].join("\n");
}
