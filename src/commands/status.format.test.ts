import { describe, expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import {
  estimateTokensFromChars,
  formatContextBreakdown,
  formatKTokens,
  formatTokensCompact,
} from "./status.format.js";

describe("estimateTokensFromChars", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokensFromChars(4000)).toBe(1000);
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(100)).toBe(25);
  });
});

describe("formatContextBreakdown", () => {
  it("returns empty array when no report is provided", () => {
    expect(formatContextBreakdown(undefined)).toEqual([]);
  });

  it("formats a full context breakdown", () => {
    const report: SessionSystemPromptReport = {
      source: "run",
      generatedAt: Date.now(),
      systemPrompt: {
        chars: 40000,
        projectContextChars: 20000,
        nonProjectContextChars: 20000,
      },
      injectedWorkspaceFiles: [
        {
          name: "SOUL.md",
          path: "/project/SOUL.md",
          missing: false,
          rawChars: 8000,
          injectedChars: 8000,
          truncated: false,
        },
        {
          name: "AGENTS.md",
          path: "/project/AGENTS.md",
          missing: false,
          rawChars: 6000,
          injectedChars: 6000,
          truncated: false,
        },
        {
          name: "MISSING.md",
          path: "/project/MISSING.md",
          missing: true,
          rawChars: 0,
          injectedChars: 0,
          truncated: false,
        },
      ],
      skills: {
        promptChars: 15000,
        entries: [
          { name: "router", blockChars: 5000 },
          { name: "memory", blockChars: 10000 },
        ],
      },
      tools: {
        listChars: 5000,
        schemaChars: 8000,
        entries: [
          { name: "search", summaryChars: 100, schemaChars: 2000, propertiesCount: 3 },
          { name: "edit", summaryChars: 80, schemaChars: 1500, propertiesCount: 2 },
        ],
      },
    };

    const lines = formatContextBreakdown(report);
    expect(lines.length).toBeGreaterThan(0);
    // Should contain system prompt total
    expect(lines[0]).toContain("System prompt");
    expect(lines[0]).toContain("40k chars");
    // Should contain workspace files
    expect(lines.some((l) => l.includes("Workspace files"))).toBe(true);
    // Should contain individual file entries (only non-missing)
    expect(lines.some((l) => l.includes("SOUL.md"))).toBe(true);
    expect(lines.some((l) => l.includes("AGENTS.md"))).toBe(true);
    expect(lines.some((l) => l.includes("MISSING.md"))).toBe(false);
    // Should contain skills
    expect(lines.some((l) => l.includes("Skills (2)"))).toBe(true);
    // Should contain tools
    expect(lines.some((l) => l.includes("Tools (2)"))).toBe(true);
    // Should contain estimated overhead
    expect(lines.some((l) => l.includes("Estimated overhead"))).toBe(true);
  });

  it("handles minimal report with only base prompt", () => {
    const report: SessionSystemPromptReport = {
      source: "run",
      generatedAt: Date.now(),
      systemPrompt: {
        chars: 5000,
        projectContextChars: 0,
        nonProjectContextChars: 5000,
      },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 0, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    };

    const lines = formatContextBreakdown(report);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("System prompt");
    // Should not contain workspace/skills/tools sections
    expect(lines.some((l) => l.includes("Workspace files"))).toBe(false);
    expect(lines.some((l) => l.includes("Skills"))).toBe(false);
    expect(lines.some((l) => l.includes("Tools"))).toBe(false);
    // Should still have base prompt and overhead
    expect(lines.some((l) => l.includes("Base prompt"))).toBe(true);
    expect(lines.some((l) => l.includes("Estimated overhead"))).toBe(true);
  });
});

describe("formatTokensCompact", () => {
  it("formats used/ctx with percentage", () => {
    expect(
      formatTokensCompact({ totalTokens: 113000, contextTokens: 190000, percentUsed: 59 }),
    ).toBe("113k/190k (59%)");
  });

  it("handles null totalTokens", () => {
    expect(
      formatTokensCompact({ totalTokens: null, contextTokens: 190000, percentUsed: null }),
    ).toBe("unknown/190k (?%)");
  });
});
