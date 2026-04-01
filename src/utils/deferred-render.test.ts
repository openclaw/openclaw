import { describe, expect, it } from "vitest";
import { renderDeferredBatch } from "./deferred-render.js";

describe("deferred-render", () => {
  it("renders batches only from explicit display payloads", () => {
    const rendered = renderDeferredBatch({
      title: "[Queued messages while agent was busy]",
      summary: "1 older message summarized",
      items: [
        { visibility: "user-visible", text: "hello" },
        { visibility: "summary-only", summaryLine: "queued follow-up summary" },
      ],
    });

    expect(rendered).toContain("Queued #1\nhello");
    expect(rendered).toContain("Queued #2\nqueued follow-up summary");
  });

  it("renders summary-only entries from summaryLine instead of hidden text", () => {
    const rendered = renderDeferredBatch({
      title: "[Queued messages while agent was busy]",
      items: [
        {
          visibility: "summary-only",
          text: "internal details that should stay hidden",
          summaryLine: "safe summary",
        },
      ],
    });

    expect(rendered).toContain("Queued #1\nsafe summary");
    expect(rendered).not.toContain("internal details that should stay hidden");
  });

  it("rejects deferred render items without explicit display content", () => {
    expect(() =>
      renderDeferredBatch({
        title: "[Queued messages while agent was busy]",
        items: [{ visibility: "user-visible", text: "   " }],
      }),
    ).toThrow(/renderable deferred item #1/);
  });
});
