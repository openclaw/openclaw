// Process-local LLM token counters, partitioned by provider. Exposed by the
// gateway HTTP server as a Prometheus text exposition under `/metrics`.
// Counters reset on process restart by design — rate-of-change is what
// dashboards care about, not lifetime totals.
//
// We track providers separately so dashboards can attribute token spend to
// `codex` (ChatGPT Plus tier, account-level quota) vs `anthropic` (per-key
// quota) and visualise fallback events when codex errors and openclaw
// transparently hands the turn to Claude. Without anthropic coverage the
// dashboard would go silent during fallback even though tokens were still
// being burned.

export type LLMProvider = "codex" | "anthropic";

const ALL_PROVIDERS: ReadonlyArray<LLMProvider> = ["codex", "anthropic"];

interface LLMUsageRecord {
  prompt: number;
  completion: number;
  cached: number;
}

interface ProviderCounters {
  prompt: number;
  completion: number;
  cached: number;
  requests: number;
}

const counters: Record<LLMProvider, ProviderCounters> = {
  codex: { prompt: 0, completion: 0, cached: 0, requests: 0 },
  anthropic: { prompt: 0, completion: 0, cached: 0, requests: 0 },
};

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

export function recordLLMUsage(provider: LLMProvider, record: LLMUsageRecord): void {
  const c = counters[provider];
  c.prompt += Math.max(0, record.prompt);
  c.completion += Math.max(0, record.completion);
  c.cached += Math.max(0, record.cached);
  c.requests += 1;
}

export function resetLLMMetrics(): void {
  for (const p of ALL_PROVIDERS) {
    counters[p] = { prompt: 0, completion: 0, cached: 0, requests: 0 };
  }
}

export function formatLLMMetricsPrometheus(): string {
  const lines: string[] = [];
  const series = [
    {
      name: "openclaw_llm_prompt_tokens_total",
      help: "Total prompt tokens consumed since process start, partitioned by provider.",
      key: "prompt" as const,
    },
    {
      name: "openclaw_llm_completion_tokens_total",
      help: "Total completion tokens emitted since process start, partitioned by provider.",
      key: "completion" as const,
    },
    {
      name: "openclaw_llm_cached_tokens_total",
      help: "Total cached prompt tokens reported since process start (codex prompt cache or anthropic cache_read), partitioned by provider.",
      key: "cached" as const,
    },
    {
      name: "openclaw_llm_requests_total",
      help: "LLM transport request count (one per completed stream), partitioned by provider.",
      key: "requests" as const,
    },
  ];
  for (const s of series) {
    lines.push(`# HELP ${s.name} ${s.help}`);
    lines.push(`# TYPE ${s.name} counter`);
    for (const p of ALL_PROVIDERS) {
      lines.push(`${s.name}{provider="${p}"} ${counters[p][s.key]}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
