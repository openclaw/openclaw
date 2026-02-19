import { describe, expect, it, vi } from "vitest";
import { sanitizeOutbound } from "./sanitize-outbound.js";

// Suppress logWarn output during tests.
vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
}));

describe("sanitizeOutbound", () => {
  // ── A. Direct leak (model outputs internal text) ──────────────────

  it("#1 blocks English Reasoning: line", () => {
    const r = sanitizeOutbound("Reasoning: I need to calculate the total sales first.");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("reasoning_en");
  });

  it("#2 blocks <thinking> tag", () => {
    const r = sanitizeOutbound("<thinking>Let me think about this carefully.</thinking>");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("thinking_tag");
  });

  it("#3 blocks [internal] prefix", () => {
    const r = sanitizeOutbound("[internal] Checking inventory for SKU-12345...");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("internal_bracket");
  });

  it("#4 blocks <scratchpad> tag", () => {
    const r = sanitizeOutbound("<scratchpad>draft notes for the weekly report</scratchpad>");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("scratchpad_tag");
  });

  it("#5 blocks --- draft --- block", () => {
    const input = "--- draft ---\nrough notes about Q1\n--- end ---";
    const r = sanitizeOutbound(input);
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("draft_block");
  });

  it("#6 blocks Chinese 推理: line", () => {
    const r = sanitizeOutbound("推理: 我需要先查看昨日的销售数据...");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("reasoning_zh");
  });

  it("#7 blocks Chinese 思考: line", () => {
    const r = sanitizeOutbound("思考: 让我想想这个问题怎么解决...");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("thinking_zh");
  });

  // ── B. Tool call leak ─────────────────────────────────────────────

  it("#8 blocks Tool call: line", () => {
    const r = sanitizeOutbound("Tool call: browser.evaluate failed with timeout");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("tool_call");
  });

  it("#9 blocks <tool_use> tag", () => {
    const r = sanitizeOutbound('<tool_use>exec {"cmd":"ls -la"}</tool_use>');
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("tool_use_tag");
  });

  it("#10 blocks ```tool_code fence", () => {
    const input = "```tool_code\nfetch('https://api.example.com')\n```";
    const r = sanitizeOutbound(input);
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
    expect(r.matchedRules).toContain("tool_code_fence");
  });

  it("#11 strips Tool call mixed in normal text", () => {
    const input = "Sales: 100 units.\nTool call: browser.evaluate returned error\nRevenue is $500.";
    const r = sanitizeOutbound(input);
    expect(r.matched).toBe(true);
    expect(r.text).not.toBeNull();
    expect(r.text).toContain("Sales: 100 units.");
    expect(r.text).toContain("Revenue is $500.");
    expect(r.text).not.toContain("Tool call:");
  });

  // ── C. Mixed leak (normal + internal interleaved) ─────────────────

  it("#12 strips Reasoning from middle of normal text", () => {
    const input =
      "Here is your daily report.\nReasoning: I need to verify the numbers.\nTotal sales: $1,234.";
    const r = sanitizeOutbound(input);
    expect(r.matched).toBe(true);
    expect(r.text).toContain("Here is your daily report.");
    expect(r.text).toContain("Total sales: $1,234.");
    expect(r.text).not.toContain("Reasoning:");
  });

  it("#13 strips <thinking> from inside normal output", () => {
    const input =
      "The return rate is 5%.\n<thinking>Let me double-check the calculation.</thinking>\nThis is within normal range.";
    const r = sanitizeOutbound(input);
    expect(r.matched).toBe(true);
    expect(r.text).toContain("The return rate is 5%.");
    expect(r.text).toContain("This is within normal range.");
    expect(r.text).not.toContain("<thinking>");
  });

  it("#14 strips multiple scattered internal segments", () => {
    const input = [
      "Report for today:",
      "Reasoning: first step",
      "Sales: $500",
      "[internal] checking cache",
      "Revenue: $800",
      "Tool call: api.getData finished",
      "Profit: $300",
    ].join("\n");
    const r = sanitizeOutbound(input);
    expect(r.matched).toBe(true);
    expect(r.text).toContain("Report for today:");
    expect(r.text).toContain("Sales: $500");
    expect(r.text).toContain("Revenue: $800");
    expect(r.text).toContain("Profit: $300");
    expect(r.text).not.toContain("Reasoning:");
    expect(r.text).not.toContain("[internal]");
    expect(r.text).not.toContain("Tool call:");
  });

  it("#15 returns null when only whitespace remains after strip", () => {
    const input = "Reasoning: this is all internal content\n   \n";
    const r = sanitizeOutbound(input);
    expect(r.text).toBeNull();
    expect(r.matched).toBe(true);
  });

  // ── D. Boundary / false positive (must NOT block) ─────────────────

  it("#16 passes user text containing 'reasoning' as normal word", () => {
    const input = "My reasoning is that we should invest more in marketing.";
    const r = sanitizeOutbound(input);
    expect(r.matched).toBe(false);
    expect(r.text).toBe(input);
  });

  it("#17 passes normal markdown code block", () => {
    const input = "```js\nconst x = 1;\nconsole.log(x);\n```";
    const r = sanitizeOutbound(input);
    expect(r.matched).toBe(false);
    expect(r.text).toBe(input);
  });

  it("#18 passes text containing 'internal' as normal word", () => {
    const input = "We have an internal team meeting at 3pm to discuss the strategy.";
    const r = sanitizeOutbound(input);
    expect(r.matched).toBe(false);
    expect(r.text).toBe(input);
  });

  // ── Edge cases ────────────────────────────────────────────────────

  it("returns null for undefined input", () => {
    const r = sanitizeOutbound(undefined);
    expect(r.text).toBeNull();
    expect(r.matched).toBe(false);
  });

  it("returns null for empty string", () => {
    const r = sanitizeOutbound("");
    expect(r.text).toBeNull();
    expect(r.matched).toBe(false);
  });
});
