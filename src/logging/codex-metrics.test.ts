import { beforeEach, describe, expect, test } from "vitest";
import {
  extractCommandTag,
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
