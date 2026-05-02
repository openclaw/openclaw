import { describe, expect, it } from "vitest";
import {
  appendFooterBlock,
  composeFooterBlock,
  formatResponseFooterBlock,
  formatResponseUsageLine,
} from "./agent-runner-usage-line.js";

describe("formatResponseFooterBlock", () => {
  it("trims surrounding blank lines after template resolution", () => {
    expect(
      formatResponseFooterBlock({
        template: "\n\n{model} · {contextPercent}%\n",
        context: { model: "claude", contextPercent: 23 },
      }),
    ).toBe("claude · 23%");
  });

  it("returns null for empty or whitespace-only results", () => {
    expect(formatResponseFooterBlock({ template: "   ", context: {} })).toBeNull();
    expect(formatResponseFooterBlock({ template: "\n\n", context: {} })).toBeNull();
  });
});

describe("appendFooterBlock", () => {
  it("appends a footer block with one blank line after the last text payload", () => {
    expect(appendFooterBlock([{ text: "Hello\n" }], "— footer")).toEqual([
      { text: "Hello\n\n— footer" },
    ]);
  });

  it("creates a text payload when none exists", () => {
    expect(appendFooterBlock([{ mediaUrl: "/tmp/example.png" }], "— footer")).toEqual([
      { mediaUrl: "/tmp/example.png" },
      { text: "— footer" },
    ]);
  });

  it("ignores blank footer blocks", () => {
    expect(appendFooterBlock([{ text: "Hello" }], "\n\n   \n")).toEqual([{ text: "Hello" }]);
  });
});


describe("formatResponseUsageLine", () => {
  it("adds model, session, and context details in full mode", () => {
    expect(
      formatResponseUsageLine({
        usage: { input: 12_000, output: 450, cacheRead: 2_000, cacheWrite: 300 },
        showCost: false,
        mode: "full",
        modelLabel: "gpt-5.4",
        contextUsedTokens: 45_234,
        contextMaxTokens: 200_000,
        contextPercent: 23,
        sessionKey: "agent:main:webchat:dm:123",
      }),
    ).toBe(
      "Usage: 12k in / 450 out · cache 2.0k cached / 300 new · ctx 45k/200k (23%) · model gpt-5.4 · session `agent:main:webchat:dm:123`",
    );
  });
});

describe("composeFooterBlock", () => {
  it("suppresses the built-in usage line when the custom footer already consumes usage", () => {
    expect(
      composeFooterBlock({
        usageLine: "Usage: 12 in / 3 out",
        footerBlock: "↑12 ↓3 · ctx 45k/200k",
        footerConsumesUsage: true,
      }),
    ).toBe("↑12 ↓3 · ctx 45k/200k");
  });

  it("folds usage and footer into a single block when the footer is static", () => {
    expect(
      composeFooterBlock({
        usageLine: "Usage: 12 in / 3 out",
        footerBlock: "— footer",
        footerConsumesUsage: false,
      }),
    ).toBe("Usage: 12 in / 3 out\n— footer");
  });
});
