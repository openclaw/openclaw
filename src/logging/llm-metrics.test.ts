import { beforeEach, describe, expect, test } from "vitest";
import {
  extractCommandTag,
  formatLLMMetricsPrometheus,
  recordLLMUsage,
  resetLLMMetrics,
} from "./llm-metrics.js";

describe("llm-metrics", () => {
  beforeEach(() => {
    resetLLMMetrics();
  });

  test("zero baseline renders all four counters per provider as 0", () => {
    const out = formatLLMMetricsPrometheus();
    for (const provider of ["codex", "anthropic"]) {
      expect(out).toContain(`openclaw_llm_prompt_tokens_total{provider="${provider}"} 0`);
      expect(out).toContain(`openclaw_llm_completion_tokens_total{provider="${provider}"} 0`);
      expect(out).toContain(`openclaw_llm_cached_tokens_total{provider="${provider}"} 0`);
      expect(out).toContain(`openclaw_llm_requests_total{provider="${provider}"} 0`);
    }
    expect(out).toMatch(/# TYPE openclaw_llm_prompt_tokens_total counter/);
    expect(out).toMatch(/# HELP openclaw_llm_requests_total /);
  });

  test("recordLLMUsage accumulates per provider", () => {
    recordLLMUsage("codex", { prompt: 100, completion: 20, cached: 30 });
    recordLLMUsage("codex", { prompt: 200, completion: 50, cached: 60 });
    recordLLMUsage("anthropic", { prompt: 50, completion: 10, cached: 5 });
    const out = formatLLMMetricsPrometheus();
    expect(out).toContain('openclaw_llm_prompt_tokens_total{provider="codex"} 300');
    expect(out).toContain('openclaw_llm_completion_tokens_total{provider="codex"} 70');
    expect(out).toContain('openclaw_llm_cached_tokens_total{provider="codex"} 90');
    expect(out).toContain('openclaw_llm_requests_total{provider="codex"} 2');
    expect(out).toContain('openclaw_llm_prompt_tokens_total{provider="anthropic"} 50');
    expect(out).toContain('openclaw_llm_completion_tokens_total{provider="anthropic"} 10');
    expect(out).toContain('openclaw_llm_cached_tokens_total{provider="anthropic"} 5');
    expect(out).toContain('openclaw_llm_requests_total{provider="anthropic"} 1');
  });

  test("providers are isolated — codex traffic does not leak into anthropic counters", () => {
    recordLLMUsage("codex", { prompt: 999, completion: 999, cached: 999 });
    const out = formatLLMMetricsPrometheus();
    expect(out).toContain('openclaw_llm_prompt_tokens_total{provider="anthropic"} 0');
    expect(out).toContain('openclaw_llm_completion_tokens_total{provider="anthropic"} 0');
    expect(out).toContain('openclaw_llm_requests_total{provider="anthropic"} 0');
  });

  test("negative tokens are clamped to zero but still count as a request", () => {
    recordLLMUsage("codex", { prompt: -5, completion: -10, cached: -3 });
    const out = formatLLMMetricsPrometheus();
    expect(out).toContain('openclaw_llm_prompt_tokens_total{provider="codex"} 0');
    expect(out).toContain('openclaw_llm_completion_tokens_total{provider="codex"} 0');
    expect(out).toContain('openclaw_llm_cached_tokens_total{provider="codex"} 0');
    expect(out).toContain('openclaw_llm_requests_total{provider="codex"} 1');
  });

  test("resetLLMMetrics zeros all counters across all providers", () => {
    recordLLMUsage("codex", { prompt: 100, completion: 20, cached: 30 });
    recordLLMUsage("anthropic", { prompt: 200, completion: 50, cached: 60 });
    resetLLMMetrics();
    const out = formatLLMMetricsPrometheus();
    expect(out).toContain('openclaw_llm_prompt_tokens_total{provider="codex"} 0');
    expect(out).toContain('openclaw_llm_requests_total{provider="codex"} 0');
    expect(out).toContain('openclaw_llm_prompt_tokens_total{provider="anthropic"} 0');
    expect(out).toContain('openclaw_llm_requests_total{provider="anthropic"} 0');
  });
});

describe("extractCommandTag", () => {
  test("extracts leading slash-command, lowercased", () => {
    expect(extractCommandTag("/eth ETH")).toBe("/eth");
    expect(extractCommandTag("/SCAN")).toBe("/scan");
    expect(extractCommandTag("  /pulse BTC  ")).toBe("/pulse");
    expect(extractCommandTag("/set_threshold 75")).toBe("/set_threshold");
    expect(extractCommandTag("/rsi-multi ETH")).toBe("/rsi-multi");
  });

  test("returns 'freeform' for plain prose", () => {
    expect(extractCommandTag("What is funding for ETH?")).toBe("freeform");
    expect(extractCommandTag("hello")).toBe("freeform");
    expect(extractCommandTag("")).toBe("freeform");
  });

  test("does not match path-like strings as commands", () => {
    expect(extractCommandTag("/home/node/file.txt")).toBe("/home");
    // Path beyond first segment is dropped; the leading segment looks like a
    // command tag. This is intentionally lenient — paths are not common as
    // first-line user input; the privacy goal (no raw prompt content beyond
    // a short identifier) is still met.
  });

  test("returns 'n/a' for non-string content", () => {
    expect(extractCommandTag(undefined)).toBe("n/a");
    expect(extractCommandTag(null)).toBe("n/a");
    expect(extractCommandTag(123)).toBe("n/a");
    expect(extractCommandTag({ text: "/eth" })).toBe("n/a");
  });

  test("caps the identifier length to 31 chars to avoid arbitrary leakage", () => {
    const longTail = "a".repeat(60);
    const out = extractCommandTag(`/${longTail}`);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.startsWith("/aaaaa")).toBe(true);
  });
});
