import { describe, expect, it } from "vitest";
import { testApi } from "./audit.js";

describe("audit command parsing", () => {
  it("parses ISO and millisecond timestamps", () => {
    expect(testApi.parseAuditTimestamp("2026-07-01T00:00:00Z", "--after")).toBe(
      Date.parse("2026-07-01T00:00:00Z"),
    );
    expect(testApi.parseAuditTimestamp("1234", "--after")).toBe(1234);
    expect(() => testApi.parseAuditTimestamp("not-a-date", "--after")).toThrow("--after");
  });

  it("keeps exports bounded", () => {
    expect(testApi.parseAuditLimit(undefined)).toBe(100);
    expect(testApi.parseAuditLimit("500")).toBe(500);
    expect(() => testApi.parseAuditLimit("501")).toThrow("1 and 500");
  });

  it("renders untrusted metadata as one terminal-safe row", () => {
    const [header, row] = testApi.formatAuditRows([
      {
        eventId: "event-1",
        sequence: 1,
        sourceSequence: 1,
        occurredAt: 0,
        kind: "tool_action",
        action: "tool.action.finished",
        status: "failed",
        actor: { type: "agent", id: "main" },
        agentId: "main\nforged",
        runId: "run\tcolumn",
        toolName: "\u001b]8;;https://example.invalid\u0007unsafe",
        redaction: "metadata_only",
      },
    ]);

    expect(header).toContain("TIME");
    expect(row).not.toContain("\n");
    expect(row).not.toContain("\u001b");
    expect(row).toContain("main\\nforged");
    expect(row).toContain("run\\tcolumn");
  });
});

describe("audit text truncation", () => {
  it("does not split surrogate pairs", async () => {
    const { truncateUtf16Safe } = await import("@openclaw/normalization-core/utf16-slice");
    const content = "x".repeat(78) + "🚀tail";
    // .slice(0, 79) would cut in the middle of the surrogate pair
    const bad = content.slice(0, 79);
    expect(bad.endsWith("\uD83D")).toBe(true);
    // truncateUtf16Safe drops the broken surrogate, keeping only 78 x's
    const good = truncateUtf16Safe(content, 79);
    expect(good).toBe("x".repeat(78));
  });
});
