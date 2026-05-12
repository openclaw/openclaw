import { beforeEach, describe, expect, test } from "vitest";
import {
  formatCodexMetricsPrometheus,
  recordCodexUsage,
  resetCodexMetrics,
} from "./codex-metrics.js";

describe("codex-metrics", () => {
  beforeEach(() => {
    resetCodexMetrics();
  });

  test("zero baseline renders all four counters as 0", () => {
    const out = formatCodexMetricsPrometheus();
    expect(out).toContain("openclaw_codex_prompt_tokens_total 0");
    expect(out).toContain("openclaw_codex_completion_tokens_total 0");
    expect(out).toContain("openclaw_codex_cached_tokens_total 0");
    expect(out).toContain("openclaw_codex_requests_total 0");
    expect(out).toMatch(/# TYPE openclaw_codex_prompt_tokens_total counter/);
    expect(out).toMatch(/# HELP openclaw_codex_requests_total /);
  });

  test("recordCodexUsage accumulates across calls", () => {
    recordCodexUsage({ prompt: 100, completion: 20, cached: 30 });
    recordCodexUsage({ prompt: 200, completion: 50, cached: 60 });
    const out = formatCodexMetricsPrometheus();
    expect(out).toContain("openclaw_codex_prompt_tokens_total 300");
    expect(out).toContain("openclaw_codex_completion_tokens_total 70");
    expect(out).toContain("openclaw_codex_cached_tokens_total 90");
    expect(out).toContain("openclaw_codex_requests_total 2");
  });

  test("negative tokens are clamped to zero", () => {
    recordCodexUsage({ prompt: -5, completion: -10, cached: -3 });
    const out = formatCodexMetricsPrometheus();
    expect(out).toContain("openclaw_codex_prompt_tokens_total 0");
    expect(out).toContain("openclaw_codex_completion_tokens_total 0");
    expect(out).toContain("openclaw_codex_cached_tokens_total 0");
    expect(out).toContain("openclaw_codex_requests_total 1");
  });

  test("resetCodexMetrics zeros all counters", () => {
    recordCodexUsage({ prompt: 100, completion: 20, cached: 30 });
    resetCodexMetrics();
    const out = formatCodexMetricsPrometheus();
    expect(out).toContain("openclaw_codex_prompt_tokens_total 0");
    expect(out).toContain("openclaw_codex_requests_total 0");
  });
});
